package voice

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/norman-w/codex-commander-go/internal/appserver"
	"github.com/norman-w/codex-commander-go/internal/config"
	"github.com/norman-w/codex-commander-go/internal/log"
	"github.com/norman-w/codex-commander-go/internal/privacy"
	"github.com/norman-w/codex-commander-go/internal/protocol"
)

const (
	minInputAudioBytes = protocol.AudioSampleRate * 2 / 10
	maxQueueBytes      = protocol.AudioSampleRate * 2 * 5
	endSilenceMS       = 700
	outputIdle         = 420 * time.Millisecond
	replyTimeout       = 20 * time.Second
)

type Events struct {
	Audio         func([]byte)
	AudioEnd      func(string)
	Caption       func(string, string)
	InputLevel    func(protocol.AudioLevel)
	OutputLevel   func(protocol.AudioLevel)
	InputDevice   func(string)
	MicrophoneErr func(string)
	Error         func(error)
}

type Host interface {
	EnsureSelectedThread(context.Context) (string, error)
	StartVoiceThread(context.Context) (string, error)
	RequestJSONRPC(context.Context, string, map[string]any, time.Duration) (any, error)
	SubscribeNotifications(func(appserver.Notification)) func()
}

type Voice struct {
	host   Host
	config config.Config
	logger *log.Logger
	events Events

	mu              sync.Mutex
	threadID        string
	sessionActive   bool
	inputStarted    bool
	inputBytes      int
	inputHadSignal  bool
	inputItemID     string
	inputQueue      chan []byte
	queueDone       chan struct{}
	queueCancel     context.CancelFunc
	queueError      error
	waitingForReply bool
	outputStarted   bool
	transcript      string
	outputTimer     *time.Timer
	replyTimer      *time.Timer
	inputSource     string
	closed          bool
	sessionStart    chan struct{}
	sessionStartErr error
	starting        bool
	unsubscribe     func()
	webrtc          *webRTCSession
}

func New(host Host, c config.Config, logger *log.Logger, events Events) *Voice {
	voice := &Voice{host: host, config: c, logger: logger, events: events, inputSource: c.AudioInputSource}
	voice.unsubscribe = host.SubscribeNotifications(func(notification appserver.Notification) {
		voice.HandleNotification(notification.Method, notification.Params)
	})
	return voice
}

func (v *Voice) IsConfigured() bool { return true }

func (v *Voice) useWebRTC() bool {
	switch v.config.RealtimeTransport {
	case "webrtc":
		return true
	case "websocket":
		return false
	default:
		return v.config.AppServerMode == "gui_shared"
	}
}

func (v *Voice) StartSession(ctx context.Context) error {
	v.mu.Lock()
	if v.sessionActive {
		v.mu.Unlock()
		return nil
	}
	if v.starting {
		wait := v.sessionStart
		v.mu.Unlock()
		select {
		case <-wait:
			v.mu.Lock()
			err := v.sessionStartErr
			v.mu.Unlock()
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	v.starting = true
	v.sessionStart = make(chan struct{})
	wait := v.sessionStart
	v.mu.Unlock()
	err := v.startSession(ctx)
	v.mu.Lock()
	v.sessionStartErr = err
	v.starting = false
	close(wait)
	v.mu.Unlock()
	return err
}

func (v *Voice) startSession(ctx context.Context) error {
	threadID, err := v.host.EnsureSelectedThread(ctx)
	if err != nil {
		return err
	}
	v.mu.Lock()
	if v.sessionActive && v.threadID == threadID {
		v.mu.Unlock()
		return nil
	}
	if v.sessionActive && v.threadID != "" {
		old := v.threadID
		oldWebRTC := v.webrtc
		v.webrtc = nil
		v.mu.Unlock()
		if oldWebRTC != nil {
			_ = oldWebRTC.Close(ctx)
		} else {
			_, _ = v.host.RequestJSONRPC(ctx, "thread/realtime/stop", map[string]any{"threadId": old}, 8*time.Second)
		}
		v.mu.Lock()
	}
	v.threadID = threadID
	v.mu.Unlock()

	if v.useWebRTC() {
		transport := newWebRTCSession(v.host, v.config, v.logger, webRTCEvents{
			Audio:       v.handleTransportAudio,
			OutputLevel: v.events.OutputLevel,
			Caption:     v.handleTransportCaption,
			Error:       v.handleTransportError,
		})
		transportErr := transport.Start(ctx, threadID)
		if transportErr != nil && strings.Contains(strings.ToLower(transportErr.Error()), "does not support realtime conversation") {
			_ = transport.Close(context.Background())
			threadID, transportErr = v.host.StartVoiceThread(ctx)
			if transportErr == nil {
				v.mu.Lock()
				v.threadID = threadID
				v.mu.Unlock()
				transport = newWebRTCSession(v.host, v.config, v.logger, webRTCEvents{
					Audio:       v.handleTransportAudio,
					OutputLevel: v.events.OutputLevel,
					Caption:     v.handleTransportCaption,
					Error:       v.handleTransportError,
				})
				transportErr = transport.Start(ctx, threadID)
			}
		}
		if transportErr != nil {
			_ = transport.Close(context.Background())
			return NewVoiceError("realtime_unavailable", fmt.Sprintf("无法打开 Codex Voice Chat：%v", transportErr), true)
		}
		v.mu.Lock()
		v.webrtc = transport
		v.mu.Unlock()
	} else {
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
		}
		_, err = v.host.RequestJSONRPC(ctx, "thread/realtime/start", params, 45*time.Second)
		if err != nil && strings.Contains(strings.ToLower(err.Error()), "does not support realtime conversation") {
			threadID, err = v.host.StartVoiceThread(ctx)
			if err == nil {
				v.mu.Lock()
				v.threadID = threadID
				v.mu.Unlock()
				params["threadId"] = threadID
				_, err = v.host.RequestJSONRPC(ctx, "thread/realtime/start", params, 45*time.Second)
			}
		}
		if err != nil {
			return NewVoiceError("realtime_unavailable", fmt.Sprintf("无法打开 Codex Voice Chat：%v", err), true)
		}
	}
	v.mu.Lock()
	v.sessionActive = true
	v.waitingForReply = false
	v.mu.Unlock()
	return nil
}

func (v *Voice) StopSession(ctx context.Context) error {
	v.AbortInput()
	v.mu.Lock()
	threadID := v.threadID
	transport := v.webrtc
	v.webrtc = nil
	v.sessionActive = false
	v.waitingForReply = false
	v.finishOutputLocked()
	v.mu.Unlock()
	if transport != nil {
		return transport.Close(ctx)
	}
	if threadID != "" {
		_, err := v.host.RequestJSONRPC(ctx, "thread/realtime/stop", map[string]any{"threadId": threadID}, 8*time.Second)
		if err != nil {
			return err
		}
	}
	return nil
}

func (v *Voice) ProbeRealtime(ctx context.Context) error {
	if err := v.StartSession(ctx); err != nil {
		return err
	}
	return nil
}

func (v *Voice) BeginInput(ctx context.Context) error {
	if err := v.StartSession(ctx); err != nil {
		return err
	}
	v.mu.Lock()
	if v.inputStarted {
		v.mu.Unlock()
		return errors.New("PTT 已经处于录音状态")
	}
	v.inputStarted = true
	v.inputBytes = 0
	v.inputHadSignal = false
	v.inputItemID = newID()
	v.queueError = nil
	transport := v.webrtc
	if transport != nil {
		v.mu.Unlock()
		if err := transport.BeginInput(); err != nil {
			v.mu.Lock()
			v.inputStarted = false
			v.mu.Unlock()
			return NewVoiceError("realtime_unavailable", "Go WebRTC 语音通道不可用："+err.Error(), true)
		}
		return nil
	}
	v.inputQueue = make(chan []byte, 128)
	v.queueDone = make(chan struct{})
	queueContext, cancel := context.WithCancel(context.Background())
	v.queueCancel = cancel
	queue, done := v.inputQueue, v.queueDone
	threadID, itemID := v.threadID, v.inputItemID
	v.mu.Unlock()
	go v.runAudioQueue(queue, done, queueContext, threadID, itemID)
	return nil
}

func (v *Voice) AppendInput(pcm []byte) {
	if len(pcm) == 0 {
		return
	}
	v.mu.Lock()
	if !v.inputStarted {
		v.mu.Unlock()
		return
	}
	copyOfPCM := append([]byte(nil), pcm...)
	v.inputBytes += len(copyOfPCM)
	v.inputHadSignal = v.inputHadSignal || measure(copyOfPCM).Active
	transport := v.webrtc
	if transport != nil {
		v.mu.Unlock()
		transport.AppendPCM(copyOfPCM)
		return
	}
	if v.inputQueue == nil || v.inputBytes > maxQueueBytes {
		v.mu.Unlock()
		return
	}
	queue := v.inputQueue
	select {
	case queue <- copyOfPCM:
	default:
		if v.queueError == nil {
			v.queueError = NewVoiceError("realtime_error", "语音输入队列已满，请稍后重试", true)
		}
	}
	v.mu.Unlock()
}

func (v *Voice) EndInput(ctx context.Context) error {
	v.mu.Lock()
	if !v.inputStarted {
		v.mu.Unlock()
		return NewVoiceError("ptt_not_active", "当前没有正在录音的语音", true)
	}
	v.inputStarted = false
	inputBytes, hadSignal := v.inputBytes, v.inputHadSignal
	transport := v.webrtc
	if transport != nil {
		inputSource := v.inputSource
		v.mu.Unlock()
		if inputBytes < minInputAudioBytes && !hadSignal && inputSource != "mac" {
			transport.AbortInput()
			return NewVoiceError("ptt_too_short", "收到的输入音频太短或没有有效声音，请再说一次", true)
		}
		if err := transport.EndInput(ctx); err != nil {
			return NewVoiceError("realtime_unavailable", "Go WebRTC 语音输入失败："+err.Error(), true)
		}
		v.mu.Lock()
		sessionActive := v.sessionActive
		v.mu.Unlock()
		if !sessionActive {
			return NewVoiceError("realtime_unavailable", "Codex 语音通道不可用，请稍后再试", true)
		}
		select {
		case <-time.After(endSilenceMS * time.Millisecond):
		case <-ctx.Done():
			return NewVoiceError("realtime_error", ctx.Err().Error(), true)
		}
		v.mu.Lock()
		v.waitingForReply = true
		v.armReplyTimerLocked()
		v.mu.Unlock()
		return nil
	}
	queue, done := v.inputQueue, v.queueDone
	itemID := v.inputItemID
	inputSource := v.inputSource
	v.inputQueue = nil
	v.queueDone = nil
	v.queueCancel = nil
	if inputBytes < minInputAudioBytes && !hadSignal && inputSource != "mac" {
		close(queue)
		v.mu.Unlock()
		<-done
		return NewVoiceError("ptt_too_short", "收到的输入音频太短或没有有效声音，请再说一次", true)
	}
	// A single silence tail is enough to close a websocket Core realtime turn;
	// unlike the browser path no client-side WebRTC commit is needed.
	silence := make([]byte, protocol.AudioSampleRate*2*endSilenceMS/1_000)
	select {
	case queue <- silence:
	default:
		v.queueError = NewVoiceError("realtime_error", "语音输入队列已满，请稍后重试", true)
	}
	close(queue)
	v.mu.Unlock()
	<-done
	v.mu.Lock()
	queueErr := v.queueError
	sessionActive := v.sessionActive
	v.mu.Unlock()
	if queueErr != nil {
		return NewVoiceError("realtime_unavailable", queueErr.Error(), true)
	}
	if !sessionActive {
		return NewVoiceError("realtime_unavailable", "Codex 语音通道不可用，请稍后再试", true)
	}
	_ = itemID
	select {
	case <-time.After(endSilenceMS * time.Millisecond):
	case <-ctx.Done():
		return NewVoiceError("realtime_error", ctx.Err().Error(), true)
	}
	v.mu.Lock()
	v.waitingForReply = true
	v.armReplyTimerLocked()
	v.mu.Unlock()
	return nil
}

func (v *Voice) AbortInput() {
	v.mu.Lock()
	transport := v.webrtc
	queue, done, cancel := v.inputQueue, v.queueDone, v.queueCancel
	if queue != nil {
		close(queue)
		v.inputQueue = nil
		v.queueDone = nil
		v.queueCancel = nil
	}
	v.inputStarted = false
	v.inputBytes = 0
	v.inputHadSignal = false
	v.waitingForReply = false
	if v.replyTimer != nil {
		v.replyTimer.Stop()
		v.replyTimer = nil
	}
	v.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	if transport != nil {
		transport.AbortInput()
	}
}

func (v *Voice) SpeakSummary(ctx context.Context, summary string) error {
	spoken := privacy.SanitizeForVisor(summary, 16_000, []string{v.config.CWD})
	if strings.TrimSpace(spoken) == "" {
		return nil
	}
	if err := v.StartSession(ctx); err != nil {
		return err
	}
	v.mu.Lock()
	threadID := v.threadID
	v.mu.Unlock()
	_, err := v.host.RequestJSONRPC(ctx, "thread/realtime/appendSpeech", map[string]any{"threadId": threadID, "text": spoken}, 8*time.Second)
	return err
}

func (v *Voice) SetAudioInputSource(source string) {
	v.mu.Lock()
	v.inputSource = source
	v.mu.Unlock()
}

func (v *Voice) SetInputActive(_ bool) {}

func (v *Voice) Close(ctx context.Context) error {
	v.AbortInput()
	v.mu.Lock()
	if v.outputTimer != nil {
		v.outputTimer.Stop()
	}
	if v.replyTimer != nil {
		v.replyTimer.Stop()
	}
	threadID := v.threadID
	transport := v.webrtc
	v.webrtc = nil
	v.threadID = ""
	v.sessionActive = false
	v.closed = true
	unsubscribe := v.unsubscribe
	v.unsubscribe = nil
	v.mu.Unlock()
	if unsubscribe != nil {
		unsubscribe()
	}
	if transport != nil {
		return transport.Close(ctx)
	}
	if threadID != "" {
		_, _ = v.host.RequestJSONRPC(ctx, "thread/realtime/stop", map[string]any{"threadId": threadID}, 8*time.Second)
	}
	return nil
}

func (v *Voice) handleTransportAudio(pcm []byte) {
	if len(pcm) == 0 {
		return
	}
	level := measure(pcm)
	if v.events.OutputLevel != nil {
		v.events.OutputLevel(level)
	}
	if !hasAudiblePCM(pcm) {
		return
	}
	v.mu.Lock()
	v.waitingForReply = false
	if v.replyTimer != nil {
		v.replyTimer.Stop()
		v.replyTimer = nil
	}
	v.outputStarted = true
	if v.outputTimer != nil {
		v.outputTimer.Stop()
	}
	v.outputTimer = time.AfterFunc(outputIdle, func() {
		v.mu.Lock()
		v.finishOutputLocked()
		v.mu.Unlock()
	})
	v.mu.Unlock()
	if v.events.Audio != nil {
		v.events.Audio(pcm)
	}
}

func (v *Voice) handleTransportCaption(role, text string, done bool) {
	if text == "" {
		return
	}
	text = privacy.SanitizeForVisor(text, 16_000, []string{v.config.CWD})
	v.mu.Lock()
	if done {
		v.transcript = text
	} else {
		v.transcript += text
		text = v.transcript
	}
	v.mu.Unlock()
	if v.events.Caption != nil {
		v.events.Caption(role, text)
	}
}

func (v *Voice) handleTransportError(err error) {
	if err == nil {
		return
	}
	v.HandleNotification("thread/realtime/error", map[string]any{"message": err.Error()})
}

func (v *Voice) runAudioQueue(queue <-chan []byte, done chan<- struct{}, requestContext context.Context, threadID, itemID string) {
	defer close(done)
	for audio := range queue {
		if threadID == "" {
			v.mu.Lock()
			if v.inputItemID == itemID {
				v.queueError = NewVoiceError("realtime_unavailable", "语音实时会话不可用", true)
			}
			v.mu.Unlock()
			continue
		}
		_, err := v.host.RequestJSONRPC(requestContext, "thread/realtime/appendAudio", map[string]any{
			"threadId": threadID,
			"audio":    map[string]any{"data": base64.StdEncoding.EncodeToString(audio), "sampleRate": protocol.AudioSampleRate, "numChannels": protocol.AudioChannels, "samplesPerChannel": len(audio) / 2, "itemId": itemID},
		}, 8*time.Second)
		if err != nil {
			v.mu.Lock()
			if v.inputItemID == itemID && v.queueError == nil {
				v.queueError = err
			}
			v.mu.Unlock()
		}
	}
}

func (v *Voice) HandleNotification(method string, params map[string]any) {
	v.mu.Lock()
	threadID := v.threadID
	v.mu.Unlock()
	if notificationThreadID(params) != "" && notificationThreadID(params) != threadID {
		return
	}
	switch method {
	case "thread/realtime/outputAudio/delta":
		audio := asMap(params["audio"])
		encoded := stringValue(audio["data"])
		if encoded == "" {
			return
		}
		pcm, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(pcm) == 0 {
			return
		}
		level := measure(pcm)
		if v.events.OutputLevel != nil {
			v.events.OutputLevel(level)
		}
		if !hasAudiblePCM(pcm) {
			return
		}
		v.mu.Lock()
		v.waitingForReply = false
		if v.replyTimer != nil {
			v.replyTimer.Stop()
			v.replyTimer = nil
		}
		v.outputStarted = true
		if v.outputTimer != nil {
			v.outputTimer.Stop()
		}
		v.outputTimer = time.AfterFunc(outputIdle, func() {
			v.mu.Lock()
			v.finishOutputLocked()
			v.mu.Unlock()
		})
		v.mu.Unlock()
		if v.events.Audio != nil {
			v.events.Audio(pcm)
		}
	case "thread/realtime/transcript/delta":
		role := normalizeRole(stringValue(params["role"]))
		delta := stringOr(params["delta"], params["text"])
		if delta == "" {
			return
		}
		v.mu.Lock()
		v.transcript += delta
		text := v.transcript
		v.mu.Unlock()
		if v.events.Caption != nil {
			v.events.Caption(role, privacy.SanitizeForVisor(text, 16_000, []string{v.config.CWD}))
		}
	case "thread/realtime/transcript/done":
		role := normalizeRole(stringValue(params["role"]))
		text := stringOr(params["text"], params["delta"])
		if text == "" {
			return
		}
		text = privacy.SanitizeForVisor(text, 16_000, []string{v.config.CWD})
		if role == "assistant" {
			v.mu.Lock()
			v.transcript = text
			v.mu.Unlock()
		}
		if v.events.Caption != nil {
			v.events.Caption(role, text)
		}
	case "thread/realtime/error":
		message := stringOr(params["message"], "Codex 语音中断")
		accessDenied := strings.Contains(strings.ToLower(message), "access denied")
		v.mu.Lock()
		v.sessionActive = false
		turnOpen := v.inputStarted || v.waitingForReply
		v.mu.Unlock()
		if turnOpen {
			v.AbortInput()
			if v.events.Error != nil {
				if accessDenied {
					v.events.Error(NewVoiceError("realtime_unavailable", "Codex Voice Chat 不可用。请关闭 ChatGPT 的 Voice Chat 后再说一次", true))
				} else {
					v.events.Error(NewVoiceError("realtime_error", "无法完成语音："+message, true))
				}
			}
		}
	case "thread/realtime/closed":
		v.mu.Lock()
		v.sessionActive = false
		v.finishOutputLocked()
		turnOpen := v.inputStarted || v.waitingForReply
		v.mu.Unlock()
		if turnOpen {
			v.AbortInput()
			if v.events.Error != nil {
				v.events.Error(NewVoiceError("realtime_unavailable", "Codex 语音通道已关闭，请再说一次", true))
			}
		}
	}
}

func (v *Voice) finishOutputLocked() {
	if v.outputTimer != nil {
		v.outputTimer.Stop()
		v.outputTimer = nil
	}
	if !v.outputStarted {
		return
	}
	v.outputStarted = false
	transcript := v.transcript
	v.transcript = ""
	if v.events.AudioEnd != nil {
		go v.events.AudioEnd(transcript)
	}
}

func (v *Voice) armReplyTimerLocked() {
	if v.replyTimer != nil {
		v.replyTimer.Stop()
	}
	v.replyTimer = time.AfterFunc(replyTimeout, func() {
		v.mu.Lock()
		if !v.waitingForReply {
			v.mu.Unlock()
			return
		}
		v.waitingForReply = false
		v.mu.Unlock()
		if v.events.Error != nil {
			v.events.Error(NewVoiceError("realtime_error", "语音没有返回结果，请再说一次", true))
		}
	})
}

func measure(audio []byte) protocol.AudioLevel {
	count := len(audio) / 2
	if count == 0 {
		return protocol.AudioLevel{}
	}
	var sum float64
	var peak float64
	for i := 0; i < count; i++ {
		value := int16(uint16(audio[i*2]) | uint16(audio[i*2+1])<<8)
		normalized := float64(value) / 32768
		if normalized < 0 {
			normalized = -normalized
		}
		sum += normalized * normalized
		if normalized > peak {
			peak = normalized
		}
	}
	return protocol.AudioLevel{RMS: sqrt(sum / float64(count)), Peak: peak, Active: peak > 0.01}
}

func sqrt(value float64) float64 {
	// Newton iteration avoids bringing a second audio/math abstraction into the hot path.
	if value <= 0 {
		return 0
	}
	x := value
	for i := 0; i < 8; i++ {
		x = (x + value/x) / 2
	}
	return x
}

func notificationThreadID(params map[string]any) string { return stringValue(params["threadId"]) }

func normalizeRole(role string) string {
	if strings.EqualFold(role, "user") {
		return "user"
	}
	return "assistant"
}

func asMap(value any) map[string]any {
	if result, ok := value.(map[string]any); ok {
		return result
	}
	return map[string]any{}
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func stringOr(first, second any) string {
	if value := stringValue(first); value != "" {
		return value
	}
	return stringValue(second)
}

func newID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "voice-input"
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return hex.EncodeToString(bytes[:4]) + "-" + hex.EncodeToString(bytes[4:6]) + "-" + hex.EncodeToString(bytes[6:8]) + "-" + hex.EncodeToString(bytes[8:10]) + "-" + hex.EncodeToString(bytes[10:])
}

type VoiceError struct {
	Code        string
	Message     string
	Recoverable bool
}

func NewVoiceError(code, message string, recoverable bool) *VoiceError {
	return &VoiceError{Code: code, Message: message, Recoverable: recoverable}
}

func (e *VoiceError) Error() string { return e.Message }
