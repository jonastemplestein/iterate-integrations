// jeeves-call — WhatsApp voice calls from the agents' own account, as a linked device of its own
// beside the Baileys bridge (whatsapp/src/whatsapp.ts, which cannot carry a call). meowcaller
// (github.com/purpshell/meowcaller) is WhatsApp's call stack in Go, over a whatsmeow session:
// 16 kHz mono frames in and out, the voice processor's own format.
//
//	jeeves-call link [number]                 pair this computer as a linked device, then exit:
//	                                          by QR code, or, with the account's own number, by
//	                                          an 8-character code typed into the phone
//	jeeves-call play <number> <file> [secs]   call the number, play the file once they answer,
//	                                          record what they say to peer.wav, hang up after secs
//	jeeves-call bridge <number> [ringSecs]    call the number and carry the call's audio over
//	                                          stdin and stdout (bridge.go): what calls.ts drives
//
// State (the linked device's keys) is $WHATSAPP_CALLS_DIR/wa-voip.db; never commit or copy it.
// While pairing, each QR code's text is written to $WHATSAPP_CALLS_DIR/qr.txt, and a pairing
// code to $WHATSAPP_CALLS_DIR/code.txt.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	whatsmeow "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/proto/waCompanionReg"
	"github.com/polymorfa/hypermeow/store"
	"github.com/polymorfa/hypermeow/store/sqlstore"
	"github.com/polymorfa/hypermeow/types"
	"github.com/polymorfa/hypermeow/types/events"
	waLog "github.com/polymorfa/hypermeow/util/log"
	meowcaller "github.com/purpshell/meowcaller"
	"github.com/rs/zerolog"
	"google.golang.org/protobuf/proto"

	_ "modernc.org/sqlite"
)

func main() {
	level := zerolog.InfoLevel
	if parsed, err := zerolog.ParseLevel(os.Getenv("LOG_LEVEL")); err == nil && parsed != zerolog.NoLevel {
		level = parsed
	}
	logger := zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: "15:04:05.000"}).Level(level).With().Timestamp().Logger()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx = logger.WithContext(ctx)

	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "link":
		phone := ""
		if len(os.Args) > 2 {
			phone = os.Args[2]
		}
		err = link(ctx, phone)
	case "play":
		if len(os.Args) < 4 {
			usage()
		}
		seconds := 25
		if len(os.Args) > 4 {
			if seconds, err = strconv.Atoi(os.Args[4]); err != nil {
				usage()
			}
		}
		err = play(ctx, os.Args[2], os.Args[3], time.Duration(seconds)*time.Second)
	case "bridge":
		if len(os.Args) < 3 {
			usage()
		}
		ring := 45
		if len(os.Args) > 3 {
			if ring, err = strconv.Atoi(os.Args[3]); err != nil {
				usage()
			}
		}
		err = bridge(ctx, os.Args[2], time.Duration(ring)*time.Second)
	default:
		usage()
	}
	if err != nil {
		logger.Fatal().Err(err).Msg("failed")
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: jeeves-call link [number] | play <number> <file.mp3|wav|opus> [seconds] | bridge <number> [ringSeconds]")
	os.Exit(2)
}

// stateDir is where the linked device's keys and the pairing QR text live.
func stateDir() string {
	if dir := os.Getenv("WHATSAPP_CALLS_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "iterate-self-host", "jonas-os", "whatsapp-calls")
}

// link pairs this computer and exits once WhatsApp has accepted it.
func link(ctx context.Context, phone string) error {
	wa, _, err := connect(ctx, phone)
	if err != nil {
		return err
	}
	defer wa.Disconnect()
	fmt.Printf("linked as %s\n", wa.Store.ID.String())
	// the pairing's first sync (app state, prekeys) runs just after the connection: give it room
	time.Sleep(15 * time.Second)
	return nil
}

// play calls target, plays file once media flows, and records the peer to peer.wav.
func play(ctx context.Context, target, file string, length time.Duration) error {
	log := zerolog.Ctx(ctx)
	wa, client, err := connect(ctx, "")
	if err != nil {
		return err
	}
	defer wa.Disconnect()

	source, err := openSource(file)
	if err != nil {
		return err
	}
	recording := filepath.Join(stateDir(), "peer.wav")
	recorder, err := meowcaller.WAVRecorder(recording)
	if err != nil {
		return fmt.Errorf("open %s: %w", recording, err)
	}

	call, err := client.Call(ctx, target)
	if err != nil {
		return fmt.Errorf("place call: %w", err)
	}
	ended := make(chan string, 1)
	ready := make(chan struct{}, 1)
	call.OnStateChange(func(phase meowcaller.CallPhase) { log.Info().Int("phase", int(phase)).Msg("call state") })
	call.OnPeerAccept(func() { log.Info().Msg("the peer answered") })
	call.OnReady(func() {
		log.Info().Str("file", file).Msg("media flowing: playing the file")
		call.Play(source)
		select {
		case ready <- struct{}{}:
		default:
		}
	})
	call.OnEnd(func(reason string) {
		select {
		case ended <- reason:
		default:
		}
	})
	call.Receive(recorder)
	log.Info().Str("call_id", call.ID()).Str("target", target).Msg("ringing")

	// ring for up to a minute, then talk for `length`
	select {
	case <-ready:
	case reason := <-ended:
		_ = recorder.Close()
		fmt.Printf("{\"answered\":false,\"ended\":%q}\n", reason)
		return nil
	case <-time.After(60 * time.Second):
		_ = call.Hangup()
		_ = recorder.Close()
		fmt.Println("{\"answered\":false,\"ended\":\"no answer in 60s\"}")
		return nil
	case <-ctx.Done():
		_ = call.Hangup()
		return ctx.Err()
	}
	reason := "hung up after " + length.String()
	select {
	case reason = <-ended:
	case <-time.After(length):
		_ = call.Hangup()
	case <-ctx.Done():
		_ = call.Hangup()
	}
	_ = recorder.Close()
	fmt.Printf("{\"answered\":true,\"ended\":%q,\"recording\":%q}\n", reason, recording)
	return nil
}

func openSource(file string) (meowcaller.AudioSource, error) {
	switch ext := strings.ToLower(filepath.Ext(file)); ext {
	case ".mp3":
		return meowcaller.MP3File(file)
	case ".wav":
		return meowcaller.WAVFile(file)
	case ".opus":
		return meowcaller.OpusFile(file)
	default:
		return nil, fmt.Errorf("unsupported audio file %q (want .mp3, .wav or .opus)", file)
	}
}

// connect opens the linked device's store and connects, pairing when it is not linked yet: by QR
// code (each code's text is written to qr.txt in the state directory), or, given the account's
// own phone number, by a pairing code typed into the phone (written to code.txt, and good for as
// long as the QR codes keep coming: 160 seconds).
func connect(ctx context.Context, pairingPhone string) (*whatsmeow.Client, *meowcaller.Client, error) {
	log := zerolog.Ctx(ctx)
	dir := stateDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, nil, err
	}
	// The linked-device entry reads "Google Chrome (Mac OS)", as meowcaller's own example pairs:
	// the companion props are read at pairing time.
	store.DeviceProps.Os = proto.String("Mac OS")
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_CHROME.Enum()

	waLogger := log.Level(zerolog.WarnLevel)
	address := "file:" + filepath.Join(dir, "wa-voip.db") + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	container, err := sqlstore.New(ctx, "sqlite", address, waLog.Zerolog(waLogger).Sub("db"))
	if err != nil {
		return nil, nil, fmt.Errorf("open store: %w", err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("load device: %w", err)
	}
	wa := whatsmeow.NewClient(device, waLog.Zerolog(waLogger).Sub("wa"))
	// meowcaller's call handlers go on before the receive loop starts
	client := meowcaller.NewClient(wa, meowcaller.WithLogger(*log))

	qrFile := filepath.Join(dir, "qr.txt")
	codeFile := filepath.Join(dir, "code.txt")
	codeAsked := false
	if wa.Store.ID == nil {
		qr, _ := wa.GetQRChannel(ctx)
		if err := wa.Connect(); err != nil {
			return nil, nil, fmt.Errorf("connect: %w", err)
		}
		for evt := range qr {
			if evt.Event != "code" {
				log.Info().Str("event", evt.Event).Msg("pairing")
				continue
			}
			if err := os.WriteFile(qrFile, []byte(evt.Code), 0o600); err != nil {
				return nil, nil, err
			}
			// the first QR code says the login connection is up: the moment to ask for a pairing code
			if pairingPhone != "" && !codeAsked {
				codeAsked = true
				code, err := wa.PairPhone(ctx, pairingPhone, true, whatsmeow.PairClientChrome, "Chrome (Mac OS)")
				if err != nil {
					return nil, nil, fmt.Errorf("ask for a pairing code: %w", err)
				}
				if err := os.WriteFile(codeFile, []byte(code), 0o600); err != nil {
					return nil, nil, err
				}
				fmt.Printf("PAIRING CODE %s\n", code)
			}
			log.Info().Int("valid_s", int(evt.Timeout.Seconds())).Str("file", qrFile).Msg("QR code: WhatsApp > Linked devices > Link a device")
		}
		_ = os.Remove(qrFile)
		_ = os.Remove(codeFile)
	} else if err := wa.Connect(); err != nil {
		return nil, nil, fmt.Errorf("connect: %w", err)
	}
	if err := waitUntilReady(ctx, wa, 60*time.Second); err != nil {
		return nil, nil, err
	}
	log.Info().Str("self", wa.Store.ID.String()).Msg("connected")
	// a device with no push name cannot send presence, and call signalling is delivered to an
	// available device
	if wa.Store.PushName == "" {
		wa.Store.PushName = "Jeeves"
	}
	if err := wa.SendPresence(ctx, types.PresenceAvailable); err != nil {
		log.Warn().Err(err).Msg("send presence failed; continuing")
	}
	return wa, client, nil
}

// waitUntilReady blocks until the client is connected and logged in, across the disconnect and
// reconnect WhatsApp makes right after a pairing.
func waitUntilReady(ctx context.Context, client *whatsmeow.Client, timeout time.Duration) error {
	ready := make(chan struct{}, 8)
	id := client.AddEventHandler(func(evt any) {
		if _, ok := evt.(*events.Connected); ok {
			select {
			case ready <- struct{}{}:
			default:
			}
		}
	})
	defer client.RemoveEventHandler(id)
	deadline := time.After(timeout)
	for !(client.IsConnected() && client.IsLoggedIn()) {
		select {
		case <-ready:
		case <-deadline:
			return errors.New("timed out waiting for the WhatsApp connection (not paired in time?)")
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
