// serve.go — the linked device, kept connected, with its calls on stdin and stdout for a parent
// process that carries their audio somewhere else (calls.ts, which carries it to the project's
// voice processor). It places calls and it is rung: an incoming call is announced and left
// ringing until the parent says to answer it. One call at a time has its audio carried. Both
// directions are JSON lines; audio is 16 kHz mono PCM16, little-endian, base64: the voice
// processor's own format and, as float32, meowcaller's.
//
//	stdin   {"call":"+44…","ring":45}   ring the number, giving up after `ring` seconds
//	        {"answer":"<callId>"}       answer the incoming call that was announced
//	        {"pcm":"…"}                 audio to say to the person, queued and played in order
//	        {"last":true}               nothing more is coming for this answer (may ride on a pcm line)
//	        {"clear":true}              drop what is queued (the person spoke over the voice)
//	        {"hangup":true}             end the call in progress
//	stdout  {"event":"ready","self":"…"}                      connected: calls can be placed
//	        {"event":"incoming","callId":"…","number":"44…"}  someone is ringing (number: digits,
//	                                                          "" when WhatsApp does not say; also
//	                                                          "from", "video", "group")
//	        {"event":"ringing","callId":"…"}                  the call asked for is ringing
//	        {"event":"failed","reason":"…"}                   the call asked for could not be placed
//	        {"event":"answered","callId":"…"}                 audio flows, either direction of call
//	        {"event":"mic","pcm":"…"}                         what the person says, one 60 ms frame a line
//	        {"event":"ended","callId":"…","reason":"…","answered":true,"stats":{…}}
//
// A call that was accepted (by the person, or by this side picking up) and carries no audio within
// a few seconds is ended with the reason "answered, but no audio flowed": the parent rings again.
//
// Closing stdin ends the call in progress and the process: a parent that died leaves no call up.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"sync"
	"sync/atomic"
	"time"

	whatsmeow "github.com/polymorfa/hypermeow"
	"github.com/polymorfa/hypermeow/types"
	"github.com/polymorfa/hypermeow/types/events"
	meowcaller "github.com/purpshell/meowcaller"
	"github.com/rs/zerolog"
)

// The voice's audio reaches this process in bursts and with the network's jitter, and the call
// plays one 60 ms frame every 60 ms: an answer starts playing once this much of it is queued (or
// it has waited this long, or it is already complete), so a late burst is absorbed by the queue
// and not heard as a gap.
const (
	startPlayingAfterSamples = 3 * meowcaller.FrameSamples // 180 ms
	startPlayingAfter        = 240 * time.Millisecond
)

// An accepted call carries audio within a second or two. One that has none after this long never
// will (the relay is not bridging it): the person hears silence, so the call is ended.
const (
	audioAfterAccept = 6 * time.Second
	noAudio          = "answered, but no audio flowed"
)

// voiceStats is what the queue saw of one call, for the call's report.
type voiceStats struct {
	// FramesPlayed and FramesHeard count 60 ms frames: said to the person, and heard from them.
	FramesPlayed int `json:"framesPlayed"`
	FramesHeard  int `json:"framesHeard"`
	// Underruns counts the times the queue ran dry in the middle of an answer: an audible gap.
	Underruns int `json:"underruns"`
	// MaxQueuedMs is the most audio that ever waited to be played.
	MaxQueuedMs int `json:"maxQueuedMs"`
	// Cleared counts the times queued audio was dropped because the person spoke over it.
	Cleared int `json:"cleared"`
}

// voiceQueue is what the parent has sent to say and the call has not yet played: an AudioSource
// that never ends. With nothing to play it answers no frame, which the call sends as silence.
type voiceQueue struct {
	mu          sync.Mutex
	samples     []float32
	playing     bool      // false while an answer's first frames gather
	waitingFrom time.Time // when the answer now gathering got its first samples
	complete    bool      // the parent said nothing more is coming for this answer
	stats       voiceStats
}

func (q *voiceQueue) push(pcm []byte) {
	samples := make([]float32, len(pcm)/2)
	for i := range samples {
		samples[i] = float32(int16(binary.LittleEndian.Uint16(pcm[2*i:]))) / 32768
	}
	q.mu.Lock()
	if len(q.samples) == 0 && !q.playing {
		q.waitingFrom = time.Now()
	}
	q.complete = false
	q.samples = append(q.samples, samples...)
	if queued := len(q.samples) * 1000 / meowcaller.SampleRate; queued > q.stats.MaxQueuedMs {
		q.stats.MaxQueuedMs = queued
	}
	q.mu.Unlock()
}

// last marks the answer complete: its tail plays out without waiting for more.
func (q *voiceQueue) last() {
	q.mu.Lock()
	q.complete = true
	q.mu.Unlock()
}

func (q *voiceQueue) clear() {
	q.mu.Lock()
	if len(q.samples) > 0 {
		q.stats.Cleared++
	}
	q.samples = nil
	q.playing = false
	q.complete = false
	q.mu.Unlock()
}

func (q *voiceQueue) heard() {
	q.mu.Lock()
	q.stats.FramesHeard++
	q.mu.Unlock()
}

func (q *voiceQueue) snapshot() voiceStats {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.stats
}

// ReadFrame is pulled once a frame interval by the call's send loop.
func (q *voiceQueue) ReadFrame() ([]float32, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.samples) == 0 {
		if q.playing && !q.complete {
			q.stats.Underruns++ // ran dry mid-answer: gather again before going on
		}
		q.playing = false
		q.complete = false
		return nil, nil
	}
	if !q.playing {
		if len(q.samples) < startPlayingAfterSamples && !q.complete && time.Since(q.waitingFrom) < startPlayingAfter {
			return nil, nil
		}
		q.playing = true
	}
	frame := make([]float32, meowcaller.FrameSamples) // a last partial frame is padded with silence
	taken := copy(frame, q.samples)
	q.samples = q.samples[taken:]
	q.stats.FramesPlayed++
	return frame, nil
}

func (q *voiceQueue) Close() error { return nil }

// liveCall is one call this process knows of: placed, or announced and perhaps answered.
type liveCall struct {
	call     *meowcaller.Call
	voice    *voiceQueue
	accepted atomic.Bool // the person picked up, or this side did
	answered atomic.Bool // audio has flowed
	ended    atomic.Bool
	over     sync.Once
}

type serveInput struct {
	Call   string `json:"call"`
	Ring   int    `json:"ring"`
	Answer string `json:"answer"`
	PCM    string `json:"pcm"`
	Last   bool   `json:"last"`
	Clear  bool   `json:"clear"`
	Hangup bool   `json:"hangup"`
}

// server is the process's state: the call whose audio is carried, and the incoming calls that
// were announced and are still ringing.
type server struct {
	ctx    context.Context
	log    *zerolog.Logger
	wa     *whatsmeow.Client
	client *meowcaller.Client

	out sync.Mutex

	mu      sync.Mutex
	active  *liveCall
	ringing map[string]*liveCall
}

func (s *server) emit(event map[string]any) {
	line, _ := json.Marshal(event)
	s.out.Lock()
	fmt.Println(string(line))
	s.out.Unlock()
}

// finish reports the call's end, once, and frees its place.
func (s *server) finish(lc *liveCall, reason string) {
	lc.over.Do(func() {
		lc.ended.Store(true)
		s.mu.Lock()
		if s.active == lc {
			s.active = nil
		}
		delete(s.ringing, lc.call.ID())
		s.mu.Unlock()
		s.emit(map[string]any{
			"event": "ended", "callId": lc.call.ID(), "reason": reason,
			"answered": lc.answered.Load(), "stats": lc.voice.snapshot(),
		})
	})
}

// hangUp ends lc from this side. The end is reported under `reason` first: meowcaller reports
// its own ("hangup") as soon as the terminate is on its way.
func (s *server) hangUp(lc *liveCall, reason string) {
	s.finish(lc, reason)
	if err := lc.call.Hangup(); err != nil {
		s.log.Warn().Err(err).Msg("hang-up failed")
	}
}

// carry wires a call's audio and its end to the parent. Its frames only flow once it is answered.
func (s *server) carry(call *meowcaller.Call) *liveCall {
	lc := &liveCall{call: call, voice: &voiceQueue{}}
	call.OnReady(func() {
		call.Play(lc.voice)
		if lc.answered.CompareAndSwap(false, true) {
			s.emit(map[string]any{"event": "answered", "callId": call.ID()})
		}
	})
	call.OnPeerAccept(func() { s.expectAudio(lc) })
	call.OnEnd(func(reason string) {
		fallback := "declined or unreachable"
		if lc.answered.Load() {
			fallback = "the person hung up"
		}
		s.finish(lc, orDefault(reason, fallback))
	})
	call.Receive(meowcaller.SinkFunc(func(frame []float32) {
		lc.voice.heard()
		pcm := make([]byte, 2*len(frame))
		for i, sample := range frame {
			clipped := math.Max(-1, math.Min(1, float64(sample)))
			binary.LittleEndian.PutUint16(pcm[2*i:], uint16(int16(clipped*32767)))
		}
		s.emit(map[string]any{"event": "mic", "pcm": base64.StdEncoding.EncodeToString(pcm)})
	}))
	return lc
}

// expectAudio ends lc when it carries no audio soon after it was accepted.
func (s *server) expectAudio(lc *liveCall) {
	lc.accepted.Store(true)
	time.AfterFunc(audioAfterAccept, func() {
		if !lc.answered.Load() && !lc.ended.Load() {
			s.log.Warn().Str("call_id", lc.call.ID()).Msg("accepted, but no audio flowed: ending the call")
			s.hangUp(lc, noAudio)
		}
	})
}

// place rings target and gives up when nobody has answered after `ring`.
func (s *server) place(target string, ring time.Duration) {
	s.mu.Lock()
	busy := s.active != nil
	s.mu.Unlock()
	if busy {
		s.emit(map[string]any{"event": "failed", "reason": "a call is already in progress"})
		return
	}
	call, err := s.client.Call(s.ctx, target)
	if err != nil {
		s.emit(map[string]any{"event": "failed", "reason": fmt.Sprintf("place call: %v", err)})
		return
	}
	lc := s.carry(call)
	s.mu.Lock()
	s.active = lc
	s.mu.Unlock()
	s.emit(map[string]any{"event": "ringing", "callId": call.ID()})
	time.AfterFunc(ring, func() {
		if !lc.accepted.Load() && !lc.ended.Load() {
			s.hangUp(lc, "no answer")
		}
	})
}

// announce tells the parent of an incoming call and leaves it ringing: the account's other
// devices ring too, and the call is the parent's to answer. It runs on whatsmeow's event
// goroutine, so it only registers and reports.
func (s *server) announce(call *meowcaller.Call, video bool) {
	lc := s.carry(call)
	s.mu.Lock()
	s.ringing[call.ID()] = lc
	s.mu.Unlock()
	peer := call.Peer()
	_, group := call.GroupState()
	s.emit(map[string]any{
		"event": "incoming", "callId": call.ID(), "from": peer.String(),
		"number": s.phoneNumberOf(call.ID(), peer), "video": video, "group": group,
	})
}

// answer picks up an incoming call that was announced and is still ringing.
func (s *server) answer(callID string) {
	s.mu.Lock()
	lc := s.ringing[callID]
	busy := s.active != nil
	if lc != nil && !busy {
		delete(s.ringing, callID)
		s.active = lc
	}
	s.mu.Unlock()
	if lc == nil {
		s.emit(map[string]any{"event": "ended", "callId": callID, "reason": "the caller had already gone", "answered": false})
		return
	}
	if busy {
		s.log.Warn().Str("call_id", callID).Msg("not answered: another call is in progress")
		return
	}
	if err := lc.call.Answer(); err != nil {
		s.log.Warn().Err(err).Msg("answer failed")
		s.hangUp(lc, fmt.Sprintf("could not be answered: %v", err))
		return
	}
	s.expectAudio(lc)
}

// callerNumbers holds, by call id, the phone number's jid WhatsApp sent beside a caller named by
// its newer id (…@lid): connect registers the handler that fills it before meowcaller's own, so
// it is there when the call is announced.
var callerNumbers sync.Map

func rememberCaller(evt any) {
	if offer, ok := evt.(*events.CallOffer); ok && !offer.CallCreatorAlt.IsEmpty() {
		callerNumbers.Store(offer.CallID, offer.CallCreatorAlt)
	}
}

// phoneNumberOf answers the caller's number as digits with its country code, or "".
func (s *server) phoneNumberOf(callID string, peer types.JID) string {
	candidates := []types.JID{peer}
	if alt, ok := callerNumbers.LoadAndDelete(callID); ok {
		candidates = append(candidates, alt.(types.JID))
	}
	for _, jid := range candidates {
		if jid.Server == types.DefaultUserServer {
			return jid.User
		}
	}
	if peer.Server == types.HiddenUserServer {
		if pn, err := s.wa.Store.LIDs.GetPNForLID(s.ctx, peer.ToNonAD()); err == nil && !pn.IsEmpty() {
			return pn.User
		}
	}
	return ""
}

func serve(ctx context.Context) error {
	log := zerolog.Ctx(ctx)
	wa, client, err := connect(ctx, "")
	if err != nil {
		return err
	}
	defer wa.Disconnect()
	s := &server{ctx: ctx, log: log, wa: wa, client: client, ringing: map[string]*liveCall{}}

	gone := make(chan error, 1)
	wa.AddEventHandler(func(evt any) {
		switch evt.(type) {
		case *events.Connected:
			// a reconnection starts unavailable, and call signalling goes to an available device
			if err := wa.SendPresence(ctx, types.PresenceAvailable); err != nil {
				log.Warn().Err(err).Msg("send presence failed")
			}
		case *events.LoggedOut:
			gone <- errors.New("this linked device was logged out: link it again (jeeves-call link)")
		case *events.StreamReplaced:
			gone <- errors.New("another process connected as this linked device")
		}
	})
	client.OnIncomingCall(func(call *meowcaller.Call) { s.announce(call, call.IsVideo()) })
	s.emit(map[string]any{"event": "ready", "self": wa.Store.ID.String()})

	closed := make(chan struct{})
	go func() {
		defer close(closed)
		lines := bufio.NewScanner(os.Stdin)
		lines.Buffer(make([]byte, 1<<20), 8<<20)
		for lines.Scan() {
			var input serveInput
			if err := json.Unmarshal(lines.Bytes(), &input); err != nil {
				log.Warn().Err(err).Msg("a line on stdin is not JSON")
				continue
			}
			if input.Call != "" {
				ring := 45
				if input.Ring > 0 {
					ring = input.Ring
				}
				go s.place(input.Call, time.Duration(ring)*time.Second)
				continue
			}
			if input.Answer != "" {
				go s.answer(input.Answer)
				continue
			}
			s.mu.Lock()
			lc := s.active
			s.mu.Unlock()
			if lc == nil {
				continue
			}
			if input.Clear {
				lc.voice.clear()
			}
			if input.PCM != "" {
				if pcm, err := base64.StdEncoding.DecodeString(input.PCM); err == nil {
					lc.voice.push(pcm)
				}
			}
			if input.Last {
				lc.voice.last()
			}
			if input.Hangup {
				reason := "cancelled"
				if lc.answered.Load() {
					reason = "hung up"
				}
				go s.hangUp(lc, reason)
			}
		}
	}()

	// Leaving needs a moment after a hang-up: the terminate has to go out before the connection
	// does, or the phone shows "reconnecting" instead of the call ending.
	leave := func(reason string) {
		s.mu.Lock()
		lc := s.active
		s.mu.Unlock()
		if lc != nil {
			s.hangUp(lc, reason)
			time.Sleep(1500 * time.Millisecond)
		}
	}
	select {
	case <-closed:
		leave("interrupted")
		return nil
	case <-ctx.Done():
		leave("interrupted")
		return nil
	case err := <-gone:
		leave("interrupted")
		return err
	}
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
