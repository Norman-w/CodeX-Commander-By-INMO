package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/norman-w/codex-commander-go/internal/appserver"
	"github.com/norman-w/codex-commander-go/internal/config"
	"github.com/norman-w/codex-commander-go/internal/log"
	"github.com/norman-w/codex-commander-go/internal/protocol"
)

const (
	webrtcCodecClockRate = 8_000
	webrtcFrameSamples   = 160 // 20 ms of PCMU at 8 kHz.
	webrtcMaxQueue       = webrtcCodecClockRate * 5
	webrtcStartTimeout   = 30 * time.Second
)

// webRTCEvents is deliberately smaller than voice.Events. The transport owns
// only WebRTC media and data-channel decoding; Voice remains the owner of
// turn state, captions, and recoverable error semantics.
type webRTCEvents struct {
	Audio       func([]byte)
	OutputLevel func(protocol.AudioLevel)
	Caption     func(role, text string, done bool)
	Error       func(error)
}

// webRTCSession is the pure-Go equivalent of the old hidden Chromium page.
// ChatGPT-managed app-server sessions accept WebRTC transport while the
// standalone appendAudio transport requires API-key auth. Pion supplies the
// SDP/ICE/data-channel/media pieces without creating a browser process.
type webRTCSession struct {
	host   Host
	config config.Config
	logger *log.Logger
	events webRTCEvents

	mu             sync.Mutex
	threadID       string
	peer           *webrtc.PeerConnection
	track          *webrtc.TrackLocalStaticRTP
	data           *webrtc.DataChannel
	inputActive    bool
	inputQueue     []int16
	drained        chan struct{}
	stop           chan struct{}
	done           chan struct{}
	ready          chan struct{}
	readyOnce      sync.Once
	startError     chan error
	startErrorOnce sync.Once
	remoteSet      bool
	closed         bool
	sequence       uint16
	timestamp      uint32
	ssrc           uint32
	unsubscribe    func()
}

func newWebRTCSession(host Host, c config.Config, logger *log.Logger, events webRTCEvents) *webRTCSession {
	drained := make(chan struct{})
	close(drained)
	return &webRTCSession{
		host:       host,
		config:     c,
		logger:     logger,
		events:     events,
		drained:    drained,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
		ready:      make(chan struct{}),
		startError: make(chan error, 1),
		ssrc:       0x434f4445,
	}
}

// Start creates a non-trickle ICE offer, asks app-server to attach it to the
// thread, then waits for the server's thread/realtime/sdp notification and
// the oai-events data channel.
func (s *webRTCSession) Start(ctx context.Context, threadID string) error {
	s.threadID = threadID
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypePCMU,
			ClockRate: webrtcCodecClockRate,
			Channels:  1,
		},
		PayloadType: 0,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return fmt.Errorf("register PCMU codec: %w", err)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))
	peer, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return fmt.Errorf("create Go WebRTC peer: %w", err)
	}
	s.mu.Lock()
	s.peer = peer
	s.mu.Unlock()

	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypePCMU,
		ClockRate: webrtcCodecClockRate,
		Channels:  1,
	}, "codex-commander-input", "codex-commander")
	if err != nil {
		_ = peer.Close()
		return fmt.Errorf("create Go WebRTC audio track: %w", err)
	}
	if _, err := peer.AddTrack(track); err != nil {
		_ = peer.Close()
		return fmt.Errorf("attach Go WebRTC audio track: %w", err)
	}
	data, err := peer.CreateDataChannel("oai-events", nil)
	if err != nil {
		_ = peer.Close()
		return fmt.Errorf("create Go WebRTC data channel: %w", err)
	}
	s.mu.Lock()
	s.track = track
	s.data = data
	s.mu.Unlock()

	data.OnOpen(func() {
		s.readyOnce.Do(func() { close(s.ready) })
	})
	data.OnMessage(func(message webrtc.DataChannelMessage) {
		s.handleDataChannel(message.Data)
	})
	peer.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		go s.readRemoteTrack(remote)
	})
	peer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			s.signalStartError(fmt.Errorf("Go WebRTC connection %s", strings.ToLower(state.String())))
		}
	})

	s.unsubscribe = s.host.SubscribeNotifications(func(notification appserver.Notification) {
		if notification.Method != "thread/realtime/sdp" {
			return
		}
		params := notification.Params
		if id := stringValue(params["threadId"]); id != "" && id != s.threadID {
			return
		}
		if sdp := findSDP(params); sdp != "" {
			go s.setRemoteSDP(sdp)
		}
	})

	offer, err := peer.CreateOffer(nil)
	if err != nil {
		return s.failStart(fmt.Errorf("create Go WebRTC offer: %w", err))
	}
	gatherComplete := webrtc.GatheringCompletePromise(peer)
	if err := peer.SetLocalDescription(offer); err != nil {
		return s.failStart(fmt.Errorf("set Go WebRTC local description: %w", err))
	}
	select {
	case <-gatherComplete:
	case <-ctx.Done():
		return s.failStart(ctx.Err())
	}
	local := peer.LocalDescription()
	if local == nil || strings.TrimSpace(local.SDP) == "" {
		return s.failStart(errors.New("Go WebRTC offer is empty after ICE gathering"))
	}
	s.logger.Info("Go WebRTC local audio codecs", map[string]any{"codecs": sdpAudioCodecs(local.SDP)})

	params := map[string]any{
		"includeStartupContext":           false,
		"flushTranscriptTailOnSessionEnd": true,
		"codexResponseHandoffPrefix":      "",
		"threadId":                        threadID,
		"codexResponsesAsItems":           false,
		"codexResponseItemPrefix":         nil,
		"initialItems":                    []any{},
		"outputModality":                  "audio",
		"realtimeSessionId":               nil,
		"version":                         "v3",
		"transport":                       map[string]any{"type": "webrtc", "sdp": local.SDP},
	}
	if voice := strings.TrimSpace(s.config.RealtimeVoice); voice != "" {
		params["voice"] = voice
	}
	result, err := s.host.RequestJSONRPC(ctx, "thread/realtime/start", params, webrtcStartTimeout)
	if err != nil {
		return s.failStart(err)
	}
	if sdp := findSDP(result); sdp != "" {
		s.logger.Info("Go WebRTC remote audio codecs", map[string]any{"codecs": sdpAudioCodecs(sdp)})
		go s.setRemoteSDP(sdp)
	}

	select {
	case <-s.ready:
		go s.writeRTP()
		return nil
	case err := <-s.startError:
		return s.failStart(err)
	case <-ctx.Done():
		return s.failStart(ctx.Err())
	case <-time.After(webrtcStartTimeout):
		return s.failStart(errors.New("Go WebRTC data channel did not open in time"))
	}
}

func (s *webRTCSession) failStart(err error) error {
	s.signalStartError(err)
	_ = s.Close(context.Background())
	return err
}

func (s *webRTCSession) signalStartError(err error) {
	if err == nil {
		return
	}
	s.startErrorOnce.Do(func() { s.startError <- err })
}

func (s *webRTCSession) setRemoteSDP(sdp string) {
	s.mu.Lock()
	if s.closed || s.remoteSet || s.peer == nil {
		s.mu.Unlock()
		return
	}
	peer := s.peer
	s.remoteSet = true
	s.mu.Unlock()
	if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		s.mu.Lock()
		s.remoteSet = false
		s.mu.Unlock()
		s.signalStartError(fmt.Errorf("set Go WebRTC remote description: %w", err))
	}
}

func (s *webRTCSession) BeginInput() error {
	s.mu.Lock()
	if s.closed || s.data == nil {
		s.mu.Unlock()
		return errors.New("Go WebRTC voice session is not open")
	}
	s.inputActive = true
	data := s.data
	s.mu.Unlock()
	return data.SendText(`{"type":"input_audio.resume"}`)
}

func (s *webRTCSession) AppendPCM(pcm []byte) {
	if len(pcm) == 0 || len(pcm)%2 != 0 {
		return
	}
	converted := downsample24To8(pcm)
	if len(converted) == 0 {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if len(s.inputQueue)+len(converted) > webrtcMaxQueue {
		s.logger.Warn("Go WebRTC input queue full; dropping oldest PCM", map[string]any{"bytes": len(pcm)})
		drop := len(s.inputQueue) + len(converted) - webrtcMaxQueue
		if drop >= len(s.inputQueue) {
			s.inputQueue = s.inputQueue[:0]
		} else {
			s.inputQueue = append([]int16(nil), s.inputQueue[drop:]...)
		}
	}
	if len(s.inputQueue) == 0 {
		s.drained = make(chan struct{})
	}
	s.inputQueue = append(s.inputQueue, converted...)
	s.mu.Unlock()
}

func (s *webRTCSession) EndInput(ctx context.Context) error {
	if err := s.waitDrained(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	if s.closed || s.data == nil {
		s.mu.Unlock()
		return errors.New("Go WebRTC voice session is closed")
	}
	s.inputActive = false
	data := s.data
	s.mu.Unlock()
	return data.SendText(`{"type":"input_audio.pause"}`)
}

func (s *webRTCSession) waitDrained(ctx context.Context) error {
	for {
		s.mu.Lock()
		if len(s.inputQueue) == 0 {
			s.mu.Unlock()
			return nil
		}
		wait := s.drained
		s.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (s *webRTCSession) AbortInput() {
	s.mu.Lock()
	s.inputActive = false
	s.inputQueue = nil
	data := s.data
	closed := s.closed
	s.mu.Unlock()
	if !closed && data != nil {
		_ = data.SendText(`{"type":"input_audio.pause"}`)
	}
}

func (s *webRTCSession) Close(ctx context.Context) error {
	s.AbortInput()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	peer := s.peer
	unsubscribe := s.unsubscribe
	s.unsubscribe = nil
	stop := s.stop
	done := s.done
	s.mu.Unlock()
	select {
	case <-stop:
	default:
		close(stop)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
	}
	if unsubscribe != nil {
		unsubscribe()
	}
	if peer != nil {
		_ = peer.Close()
	}
	if s.threadID != "" {
		_, err := s.host.RequestJSONRPC(ctx, "thread/realtime/stop", map[string]any{"threadId": s.threadID}, 8*time.Second)
		return err
	}
	return nil
}

func (s *webRTCSession) writeRTP() {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	defer close(s.done)
	frame := make([]int16, webrtcFrameSamples)
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			s.mu.Lock()
			for i := range frame {
				frame[i] = 0
			}
			copy(frame, s.inputQueue)
			if len(s.inputQueue) <= len(frame) {
				s.inputQueue = s.inputQueue[:0]
				select {
				case <-s.drained:
				default:
					close(s.drained)
				}
			} else {
				s.inputQueue = append([]int16(nil), s.inputQueue[len(frame):]...)
			}
			track := s.track
			sequence := s.sequence
			timestamp := s.timestamp
			ssrc := s.ssrc
			s.sequence++
			s.timestamp += webrtcFrameSamples
			s.mu.Unlock()
			if track == nil {
				continue
			}
			payload := encodeMuLaw(frame)
			if err := track.WriteRTP(&rtp.Packet{Header: rtp.Header{
				Version:        2,
				PayloadType:    0,
				SequenceNumber: sequence,
				Timestamp:      timestamp,
				SSRC:           ssrc,
				Marker:         true,
			}, Payload: payload}); err != nil {
				s.logger.Debug("Go WebRTC RTP write failed", map[string]any{"error": err.Error()})
			}
		}
	}
}

func (s *webRTCSession) readRemoteTrack(track *webrtc.TrackRemote) {
	codec := strings.ToLower(track.Codec().MimeType)
	s.logger.Info("Go WebRTC remote audio track received", map[string]any{
		"codec":       track.Codec().MimeType,
		"clockRate":   track.Codec().ClockRate,
		"channels":    track.Codec().Channels,
		"payloadType": track.PayloadType(),
	})
	packets := 0
	audiblePackets := 0
	for {
		packet, _, err := track.ReadRTP()
		if err != nil {
			if !s.isClosed() {
				s.logger.Warn("Go WebRTC remote audio ended", map[string]any{"packets": packets, "error": err.Error()})
			}
			return
		}
		packets++
		pcm8 := decodeRTPAudio(codec, packet.Payload)
		if len(pcm8) == 0 {
			if packets <= 3 {
				s.logger.Warn("Go WebRTC remote audio codec is not decoded", map[string]any{"codec": codec, "bytes": len(packet.Payload)})
			}
			continue
		}
		pcm24 := upsample8To24(pcm8)
		level := measure(pcm24)
		if packets <= 3 {
			s.logger.Info("Go WebRTC remote audio packet", map[string]any{"codec": codec, "bytes": len(packet.Payload), "peak": level.Peak, "active": level.Active})
		}
		if hasAudiblePCM(pcm24) {
			audiblePackets++
			if audiblePackets <= 3 {
				s.logger.Info("Go WebRTC audible remote audio packet", map[string]any{"codec": codec, "bytes": len(packet.Payload), "peak": level.Peak, "packet": packets})
			}
		}
		if s.events.OutputLevel != nil {
			s.events.OutputLevel(level)
		}
		if hasAudiblePCM(pcm24) && s.events.Audio != nil {
			s.events.Audio(pcm24)
		}
	}
}

func (s *webRTCSession) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func (s *webRTCSession) handleDataChannel(data []byte) {
	var event map[string]any
	if err := json.Unmarshal(data, &event); err != nil {
		return
	}
	typ := stringValue(event["type"])
	switch typ {
	case "response.audio_transcript.delta", "response.output_audio_transcript.delta", "conversation.item.input_audio_transcription.delta":
		role := "assistant"
		if strings.Contains(typ, "input_audio") {
			role = "user"
		}
		if delta := stringValue(event["delta"]); delta != "" && s.events.Caption != nil {
			s.events.Caption(role, delta, false)
		}
	case "response.audio_transcript.done", "response.output_audio_transcript.done", "conversation.item.input_audio_transcription.completed":
		role := "assistant"
		if strings.Contains(typ, "input_audio") {
			role = "user"
		}
		text := stringValue(event["transcript"])
		if text == "" {
			text = stringValue(event["text"])
		}
		if text != "" && s.events.Caption != nil {
			s.events.Caption(role, text, true)
		}
	case "error":
		message := "Codex 语音中断"
		if errorValue, ok := event["error"].(map[string]any); ok {
			if text := stringValue(errorValue["message"]); text != "" {
				message = text
			}
		}
		if s.events.Error != nil {
			s.events.Error(errors.New(message))
		}
	}
}

func findSDP(value any) string {
	return findSDPDepth(value, 0)
}

func findSDPDepth(value any, depth int) string {
	if depth > 6 {
		return ""
	}
	switch current := value.(type) {
	case map[string]any:
		for _, key := range []string{"sdp", "answerSdp"} {
			if text := stringValue(current[key]); text != "" {
				return text
			}
		}
		for _, key := range []string{"answer", "transport", "payload", "result", "data"} {
			if text := findSDPDepth(current[key], depth+1); text != "" {
				return text
			}
		}
	case []any:
		for _, item := range current {
			if text := findSDPDepth(item, depth+1); text != "" {
				return text
			}
		}
	}
	return ""
}

func sdpAudioCodecs(sdp string) []string {
	var codecs []string
	inAudioSection := false
	for _, line := range strings.Split(sdp, "\r\n") {
		if strings.HasPrefix(line, "m=") {
			inAudioSection = strings.HasPrefix(line, "m=audio ")
		}
		if inAudioSection && strings.HasPrefix(line, "a=rtpmap:") {
			codecs = append(codecs, line)
		}
	}
	return codecs
}

func downsample24To8(pcm []byte) []int16 {
	samples := len(pcm) / 2
	result := make([]int16, 0, (samples+2)/3)
	for index := 0; index < samples; index += 3 {
		var sum int
		count := 0
		for offset := 0; offset < 3 && index+offset < samples; offset++ {
			value := int16(uint16(pcm[(index+offset)*2]) | uint16(pcm[(index+offset)*2+1])<<8)
			sum += int(value)
			count++
		}
		result = append(result, int16(sum/count))
	}
	return result
}

func upsample8To24(pcm []int16) []byte {
	result := make([]byte, len(pcm)*3*2)
	index := 0
	for _, sample := range pcm {
		for repeat := 0; repeat < 3; repeat++ {
			result[index] = byte(sample)
			result[index+1] = byte(uint16(sample) >> 8)
			index += 2
		}
	}
	return result
}

func encodeMuLaw(samples []int16) []byte {
	result := make([]byte, len(samples))
	for index, sample := range samples {
		result[index] = linearToMuLaw(sample)
	}
	return result
}

func linearToMuLaw(sample int16) byte {
	const clip = 32635
	value := int(sample)
	sign := 0
	if value < 0 {
		sign = 0x80
		value = -value
	}
	if value > clip {
		value = clip
	}
	value += 0x84
	exponent := 7
	for mask := 0x4000; exponent > 0 && value&mask == 0; mask >>= 1 {
		exponent--
	}
	mantissa := (value >> (exponent + 3)) & 0x0f
	return ^byte(sign | exponent<<4 | mantissa)
}

func decodeRTPAudio(codec string, payload []byte) []int16 {
	if strings.Contains(codec, "pcmu") {
		result := make([]int16, len(payload))
		for index, value := range payload {
			result[index] = muLawToLinear(value)
		}
		return result
	}
	if strings.Contains(codec, "pcma") {
		result := make([]int16, len(payload))
		for index, value := range payload {
			result[index] = aLawToLinear(value)
		}
		return result
	}
	return nil
}

func muLawToLinear(value byte) int16 {
	value = ^value
	t := ((int(value&0x0f) << 3) + 0x84) << ((value & 0x70) >> 4)
	if value&0x80 != 0 {
		return int16(0x84 - t)
	}
	return int16(t - 0x84)
}

func aLawToLinear(value byte) int16 {
	value ^= 0x55
	t := int(value&0x0f) << 4
	segment := int((value & 0x70) >> 4)
	if segment == 0 {
		t += 8
	} else if segment == 1 {
		t += 0x108
	} else {
		t += 0x108
		t <<= segment - 1
	}
	if value&0x80 != 0 {
		return int16(t)
	}
	return int16(-t)
}

// hasAudiblePCM matches the old native realtime client: the diagnostic meter
// uses a human-facing 1% threshold, but audio delivery must keep quiet speech
// above the PCM quantization floor instead of treating it as silence.
func hasAudiblePCM(audio []byte) bool {
	for index := 0; index+1 < len(audio); index += 2 {
		value := int16(uint16(audio[index]) | uint16(audio[index+1])<<8)
		magnitude := int(value)
		if magnitude < 0 {
			magnitude = -magnitude
		}
		if magnitude > 8 {
			return true
		}
	}
	return false
}
