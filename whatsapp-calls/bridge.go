// bridge.go — ONE call with its audio on stdin and stdout, for a parent process that carries it
// somewhere else (calls.ts, which carries it to the project's voice processor). Both directions
// are JSON lines; audio is 16 kHz mono PCM16, little-endian, base64: the voice processor's own
// format and, as float32, meowcaller's.
//
//	stdin   {"pcm":"…"}          audio to say to the person, queued and played in order
//	        {"last":true}        nothing more is coming for this answer (may ride on a pcm line)
//	        {"clear":true}       drop what is queued (the person spoke over the voice)
//	        {"hangup":true}      end the call
//	stdout  {"event":"ringing","callId":"…"}
//	        {"event":"answered"}
//	        {"event":"mic","pcm":"…"}   what the person says, one 60 ms frame a line
//	        {"event":"ended","reason":"…","answered":true,"stats":{…}}
//
// Closing stdin ends the call too: a parent that died leaves no call ringing.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sync"
	"time"

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

type bridgeInput struct {
	PCM    string `json:"pcm"`
	Last   bool   `json:"last"`
	Clear  bool   `json:"clear"`
	Hangup bool   `json:"hangup"`
}

func bridge(ctx context.Context, target string, ring time.Duration) error {
	log := zerolog.Ctx(ctx)
	var out sync.Mutex
	emit := func(event map[string]any) {
		line, _ := json.Marshal(event)
		out.Lock()
		fmt.Println(string(line))
		out.Unlock()
	}

	wa, client, err := connect(ctx, "")
	if err != nil {
		return err
	}
	defer wa.Disconnect()
	call, err := client.Call(ctx, target)
	if err != nil {
		return fmt.Errorf("place call: %w", err)
	}

	voice := &voiceQueue{}
	ended := make(chan string, 1)
	answered := make(chan struct{}, 1)
	call.OnReady(func() {
		call.Play(voice)
		select {
		case answered <- struct{}{}:
		default:
		}
	})
	call.OnEnd(func(reason string) {
		select {
		case ended <- reason:
		default:
		}
	})
	call.Receive(meowcaller.SinkFunc(func(frame []float32) {
		voice.heard()
		pcm := make([]byte, 2*len(frame))
		for i, sample := range frame {
			clipped := math.Max(-1, math.Min(1, float64(sample)))
			binary.LittleEndian.PutUint16(pcm[2*i:], uint16(int16(clipped*32767)))
		}
		emit(map[string]any{"event": "mic", "pcm": base64.StdEncoding.EncodeToString(pcm)})
	}))
	emit(map[string]any{"event": "ringing", "callId": call.ID()})

	// the parent's lines; a closed stdin is a hang-up
	hangup := make(chan struct{}, 1)
	go func() {
		lines := bufio.NewScanner(os.Stdin)
		lines.Buffer(make([]byte, 1<<20), 8<<20)
		for lines.Scan() {
			var input bridgeInput
			if err := json.Unmarshal(lines.Bytes(), &input); err != nil {
				log.Warn().Err(err).Msg("a line on stdin is not JSON")
				continue
			}
			if input.Clear {
				voice.clear()
			}
			if input.PCM != "" {
				if pcm, err := base64.StdEncoding.DecodeString(input.PCM); err == nil {
					voice.push(pcm)
				}
			}
			if input.Last {
				voice.last()
			}
			if input.Hangup {
				break
			}
		}
		hangup <- struct{}{}
	}()

	wasAnswered := false
	finish := func(reason string) error {
		emit(map[string]any{"event": "ended", "reason": reason, "answered": wasAnswered, "stats": voice.snapshot()})
		return nil
	}
	// Our own hang-up needs a moment after it: meowcaller reports the call ended before its
	// terminate has gone out, and leaving at once drops the connection first, which the phone
	// shows as "reconnecting" instead of the call ending.
	hangUp := func() {
		if err := call.Hangup(); err != nil {
			log.Warn().Err(err).Msg("hang-up failed")
		}
		time.Sleep(1500 * time.Millisecond)
	}
	select {
	case <-answered:
		wasAnswered = true
		emit(map[string]any{"event": "answered"})
	case reason := <-ended:
		return finish(orDefault(reason, "declined or unreachable"))
	case <-time.After(ring):
		hangUp()
		return finish("no answer")
	case <-hangup:
		hangUp()
		return finish("cancelled")
	case <-ctx.Done():
		hangUp()
		return finish("interrupted")
	}
	select {
	case reason := <-ended:
		return finish(orDefault(reason, "the person hung up"))
	case <-hangup:
		hangUp()
		return finish("hung up")
	case <-ctx.Done():
		hangUp()
		return finish("interrupted")
	}
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
