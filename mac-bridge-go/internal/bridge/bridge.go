package bridge

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/norman-w/codex-commander-go/internal/audio"
	"github.com/norman-w/codex-commander-go/internal/codex"
	"github.com/norman-w/codex-commander-go/internal/config"
	"github.com/norman-w/codex-commander-go/internal/log"
	"github.com/norman-w/codex-commander-go/internal/media"
	"github.com/norman-w/codex-commander-go/internal/protocol"
	"github.com/norman-w/codex-commander-go/internal/security"
	"github.com/norman-w/codex-commander-go/internal/voice"
)

type Transport interface {
	SendControl(map[string]any) error
	SendBinary([]byte) error
	Close(code int, reason string) error
}

type session struct {
	transport     Transport
	authenticated bool
	deviceID      string
	pttActive     bool
}

type voiceDiagnosticEvent struct {
	ID   int64  `json:"id"`
	At   int64  `json:"at"`
	Type string `json:"type"`
	Role string `json:"role,omitempty"`
	Text string `json:"text,omitempty"`
}

type Bridge struct {
	config  config.Config
	logger  *log.Logger
	pairing *security.PairingStore
	codex   *codex.Controller
	images  *media.Service
	voice   *voice.Voice

	mu                   sync.RWMutex
	ready                bool
	sessions             map[string]*session
	imageCards           []protocol.ImageCard
	localAudioOutput     string
	audioInputSource     string
	inputLevel           protocol.AudioLevel
	outputLevel          protocol.AudioLevel
	inputLevelAt         time.Time
	outputLevelAt        time.Time
	diagnosticActive     bool
	voiceChatActive      bool
	voiceChatPhase       string
	voiceChatError       string
	voiceTurnActive      bool
	audioResponseActive  bool
	audioInputDevice     string
	audioInputTransport  string
	managementAudioAt    time.Time
	diagnosticFrames     int
	diagnosticBytes      int
	voiceEventID         int64
	voiceEvents          []voiceDiagnosticEvent
	managementSinks      map[int]func([]byte)
	nextSinkID           int
	nativeCapture        *audio.Capture
	nativeCaptureActive  bool
	nativePlayer         *audio.Player
	nativePlayerDisabled bool

	journal       *EventJournal
	dedupe        *RequestDeduplicator
	voiceOpMu     sync.Mutex
	audioMu       sync.Mutex
	nativeInputMu sync.Mutex
}

func New(c config.Config, logger *log.Logger) *Bridge {
	b := &Bridge{
		config: c, logger: logger,
		pairing:             security.NewPairingStore(c.PairingFile),
		images:              media.NewService(c.MediaRoots, c.MediaRoot),
		sessions:            make(map[string]*session),
		localAudioOutput:    c.LocalAudioOutput,
		audioInputSource:    c.AudioInputSource,
		audioInputTransport: "none",
		voiceChatPhase:      "stopped",
		managementSinks:     make(map[int]func([]byte)),
		imageCards:          make([]protocol.ImageCard, 0),
		journal:             NewEventJournal(300),
		dedupe:              NewRequestDeduplicator(1_000),
	}
	b.codex = codex.New(c, logger, codex.Callbacks{
		TaskEvent: func(event codex.TaskEvent) {
			b.publish(b.journal.Create(map[string]any{"type": "task_event", "threadId": event.ThreadID, "turnId": nullableString(event.TurnID), "phase": event.Phase, "message": event.Message, "final": event.Final}, true))
		},
		ApprovalRequested: func(card protocol.ApprovalCard) {
			b.publish(b.journal.Create(map[string]any{"type": "approval_request", "approval": card}, true))
		},
		ApprovalResolved: func(requestID, resolution string) {
			b.publish(b.journal.Create(map[string]any{"type": "approval_resolved", "approvalRequestId": requestID, "resolution": resolution}, true))
		},
		ImageFound: func(path, title string) {
			go func() {
				image, err := b.images.Prepare(path, title)
				if err != nil {
					b.logger.Warn("Could not prepare Codex image", map[string]any{"error": err.Error()})
					return
				}
				b.publishImage(image)
			}()
		},
	})
	b.voice = voice.New(b.codex, c, logger, voice.Events{
		Audio:         func(audio []byte) { b.handleVoiceAudio(audio) },
		AudioEnd:      func(transcript string) { b.handleVoiceAudioEnd(transcript) },
		Caption:       func(role, text string) { b.handleVoiceCaption(role, text) },
		InputLevel:    func(level protocol.AudioLevel) { b.handleInputLevel(level) },
		OutputLevel:   func(level protocol.AudioLevel) { b.handleOutputLevel(level) },
		InputDevice:   func(label string) { b.setAudioInputDevice(label, "native") },
		MicrophoneErr: func(message string) { b.handleMicrophoneError(message) },
		Error:         func(err error) { b.handleVoiceError(err) },
	})
	return b
}

func (b *Bridge) Start(ctx context.Context) (security.PairingSnapshot, error) {
	snapshot, err := b.pairing.Initialize()
	if err != nil {
		return security.PairingSnapshot{}, err
	}
	if err := b.codex.Start(ctx); err != nil {
		return snapshot, err
	}
	b.mu.Lock()
	b.ready = true
	b.voiceChatPhase = "stopped"
	b.voiceChatError = ""
	b.mu.Unlock()
	return snapshot, nil
}

func (b *Bridge) Stop(ctx context.Context) error {
	b.mu.Lock()
	b.ready = false
	b.diagnosticActive = false
	b.voiceTurnActive = false
	b.voiceChatActive = false
	b.voiceChatPhase = "stopped"
	sessions := make([]*session, 0, len(b.sessions))
	for _, current := range b.sessions {
		sessions = append(sessions, current)
	}
	b.sessions = make(map[string]*session)
	b.mu.Unlock()
	b.stopNativeInput()
	b.audioMu.Lock()
	player := b.nativePlayer
	b.nativePlayer = nil
	b.audioMu.Unlock()
	if player != nil {
		player.Close()
	}
	_ = b.voice.Close(ctx)
	for _, current := range sessions {
		_ = current.transport.Close(1001, "bridge stopping")
	}
	return b.codex.Stop()
}

func (b *Bridge) IsReady() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.ready
}

func (b *Bridge) PairingSnapshot() security.PairingSnapshot { return b.pairing.Snapshot() }

func (b *Bridge) ValidateMediaToken(deviceID, token string) bool {
	return b.pairing.IsTokenValid(deviceID, token)
}

func (b *Bridge) GetLocalAudioOutput() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.localAudioOutput
}

func (b *Bridge) GetAudioInputSource() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.audioInputSource
}

func (b *Bridge) GetVoiceTargetState(ctx context.Context) (map[string]any, error) {
	targets, err := b.codex.ListVoiceTargets(ctx)
	if err != nil {
		return nil, err
	}
	b.mu.RLock()
	state := map[string]any{"selectedThreadId": nullableString(b.codex.SelectedThreadID()), "threads": targets, "voiceChatActive": b.voiceChatActive, "voiceChatPhase": b.voiceChatPhase}
	b.mu.RUnlock()
	return state, nil
}

func (b *Bridge) SelectVoiceTarget(ctx context.Context, threadID string) error {
	if err := b.assertVoiceTargetUnlocked(); err != nil {
		return err
	}
	if err := b.codex.SelectVoiceTarget(ctx, threadID); err != nil {
		return err
	}
	b.broadcastStateSync(ctx)
	return nil
}

func (b *Bridge) CreateVoiceTarget(ctx context.Context) error {
	if err := b.assertVoiceTargetUnlocked(); err != nil {
		return err
	}
	if _, err := b.codex.CreateNewThread(ctx); err != nil {
		return err
	}
	b.broadcastStateSync(ctx)
	return nil
}

func (b *Bridge) ArchiveVoiceTargets(ctx context.Context) (int, error) {
	if err := b.assertVoiceTargetUnlocked(); err != nil {
		return 0, err
	}
	archived, err := b.codex.ArchiveVoiceTargets(ctx)
	if err != nil {
		return archived, err
	}
	b.broadcastStateSync(ctx)
	return archived, nil
}

func (b *Bridge) AudioDiagnostics() map[string]any {
	b.mu.RLock()
	now := time.Now()
	input := b.inputLevel
	output := b.outputLevel
	if now.Sub(b.inputLevelAt) > 600*time.Millisecond {
		input = protocol.AudioLevel{}
	}
	if now.Sub(b.outputLevelAt) > 600*time.Millisecond {
		output = protocol.AudioLevel{}
	}
	events := append([]voiceDiagnosticEvent(nil), b.voiceEvents...)
	result := map[string]any{
		"audioInputSource":    b.audioInputSource,
		"audioInputDevice":    nullableString(b.audioInputDevice),
		"audioInputTransport": b.audioInputTransport,
		"localAudioOutput":    b.localAudioOutput,
		"voiceChatActive":     b.voiceChatActive,
		"voiceChatPhase":      b.voiceChatPhase,
		"voiceChatError":      nullableString(b.voiceChatError),
		"testActive":          b.diagnosticActive,
		"voiceTurnActive":     b.voiceTurnActive,
		"inputFrames":         b.diagnosticFrames,
		"inputBytes":          b.diagnosticBytes,
		"visorConnected":      b.anyAuthenticatedLocked(),
		"input":               input,
		"output":              output,
		"voiceEvents":         events,
	}
	b.mu.RUnlock()
	return result
}

func (b *Bridge) SetAudioInputSource(source string) {
	if source != "visor" && source != "mac" {
		return
	}
	b.mu.Lock()
	b.audioInputSource = source
	b.inputLevelAt = time.Time{}
	b.audioInputTransport = map[bool]string{true: "visor", false: "none"}[source == "visor"]
	b.mu.Unlock()
	b.voice.SetAudioInputSource(source)
	if source != "mac" {
		b.stopNativeInput()
	}
}

func (b *Bridge) SetLocalAudioOutput(output string) {
	if output != "visor_only" && output != "mac_only" && output != "mac_and_visor" {
		return
	}
	b.mu.Lock()
	previous := b.localAudioOutput
	b.localAudioOutput = output
	active := b.audioResponseActive
	b.mu.Unlock()
	b.voice.SetLocalAudioOutput(output)
	if output == "mac_only" || output == "mac_and_visor" {
		b.audioMu.Lock()
		b.nativePlayerDisabled = false
		b.audioMu.Unlock()
	}
	if output == "mac_only" && previous != output && active {
		b.mu.Lock()
		b.audioResponseActive = false
		b.mu.Unlock()
		b.publish(b.journal.Create(map[string]any{"type": "assistant_audio_end"}, false))
	}
}

func (b *Bridge) StartVoiceChat(ctx context.Context) error {
	b.voiceOpMu.Lock()
	defer b.voiceOpMu.Unlock()
	b.mu.Lock()
	if b.voiceChatActive {
		b.mu.Unlock()
		return nil
	}
	b.voiceChatPhase = "starting"
	b.voiceChatError = ""
	b.voiceTurnActive = false
	b.audioResponseActive = false
	b.diagnosticActive = false
	b.mu.Unlock()
	b.stopNativeInput()
	if err := b.voice.StartSession(ctx); err != nil {
		b.mu.Lock()
		b.voiceChatPhase = "error"
		b.voiceChatError = err.Error()
		b.mu.Unlock()
		_ = b.broadcastStateSync(ctx)
		return err
	}
	b.mu.Lock()
	b.voiceChatActive = true
	b.voiceChatPhase = "connected"
	b.mu.Unlock()
	return b.broadcastStateSync(ctx)
}

func (b *Bridge) StopVoiceChat(ctx context.Context) error {
	b.voiceOpMu.Lock()
	defer b.voiceOpMu.Unlock()
	b.mu.RLock()
	active := b.voiceChatActive
	phase := b.voiceChatPhase
	b.mu.RUnlock()
	if !active && phase == "stopped" {
		return nil
	}
	b.mu.Lock()
	b.voiceChatPhase = "stopping"
	b.mu.Unlock()
	b.stopNativeInput()
	if err := b.voice.StopSession(ctx); err != nil {
		b.mu.Lock()
		b.voiceChatPhase = "error"
		b.voiceChatError = err.Error()
		b.mu.Unlock()
		return err
	}
	b.mu.Lock()
	b.voiceChatActive = false
	b.voiceChatPhase = "stopped"
	b.diagnosticActive = false
	b.mu.Unlock()
	return b.broadcastStateSync(ctx)
}

func (b *Bridge) StartAudioTest(ctx context.Context) error {
	b.mu.Lock()
	if !b.voiceChatActive {
		b.mu.Unlock()
		return NewBridgeError("voice_chat_inactive", "请先启动 Voice Chat，再开始音频测试", true)
	}
	if b.diagnosticActive {
		b.mu.Unlock()
		return nil
	}
	if b.voiceTurnActive || b.audioResponseActive {
		b.mu.Unlock()
		return NewBridgeError("voice_turn_active", "上一轮语音回复尚未结束，请等待原生音频结束", true)
	}
	if b.anyPTTLocked() {
		b.mu.Unlock()
		return NewBridgeError("ptt_active", "眼镜正在录音，请先结束眼镜 PTT", true)
	}
	b.diagnosticActive = true
	b.diagnosticFrames = 0
	b.diagnosticBytes = 0
	b.inputLevel = protocol.AudioLevel{}
	b.inputLevelAt = time.Time{}
	source := b.audioInputSource
	b.mu.Unlock()
	b.voice.SetAudioInputSource(source)
	if err := b.voice.BeginInput(ctx); err != nil {
		b.mu.Lock()
		b.diagnosticActive = false
		b.mu.Unlock()
		return err
	}
	b.mu.Lock()
	b.voiceTurnActive = true
	b.mu.Unlock()
	if source == "mac" {
		if err := b.startNativeInput(); err != nil {
			b.voice.AbortInput()
			b.mu.Lock()
			b.diagnosticActive = false
			b.voiceTurnActive = false
			b.mu.Unlock()
			return NewBridgeError("microphone_unavailable", "Go 原生麦克风不可用："+err.Error(), true)
		}
	}
	return nil
}

func (b *Bridge) StopAudioTest(ctx context.Context) error {
	b.mu.Lock()
	active := b.diagnosticActive
	b.mu.Unlock()
	if !active {
		return nil
	}
	b.stopNativeInput()
	err := b.voice.EndInput(ctx)
	b.mu.Lock()
	b.diagnosticActive = false
	b.voiceTurnActive = false
	b.mu.Unlock()
	return err
}

func (b *Bridge) SendAudioTestSample(ctx context.Context) error {
	b.mu.Lock()
	if !b.voiceChatActive {
		b.mu.Unlock()
		return NewBridgeError("voice_chat_inactive", "请先启动 Voice Chat，再发送测试音频", true)
	}
	if b.diagnosticActive || b.voiceTurnActive || b.audioResponseActive || b.anyPTTLocked() {
		b.mu.Unlock()
		return NewBridgeError("voice_turn_active", "上一轮语音回复尚未结束，请等待原生音频结束", true)
	}
	source := b.audioInputSource
	b.diagnosticActive = true
	b.diagnosticFrames = 0
	b.diagnosticBytes = 0
	b.mu.Unlock()
	audio, err := parseProbeWAV(b.config.ProbeAudioPath)
	if err != nil {
		b.mu.Lock()
		b.diagnosticActive = false
		b.mu.Unlock()
		return err
	}
	b.voice.SetAudioInputSource(source)
	if err := b.voice.BeginInput(ctx); err != nil {
		b.mu.Lock()
		b.diagnosticActive = false
		b.mu.Unlock()
		return err
	}
	b.mu.Lock()
	b.voiceTurnActive = true
	b.mu.Unlock()
	for offset := 0; offset < len(audio); offset += protocol.AudioSampleRate * 2 * 40 / 1_000 {
		end := offset + protocol.AudioSampleRate*2*40/1_000
		if end > len(audio) {
			end = len(audio)
		}
		frame := audio[offset:end]
		b.mu.Lock()
		b.inputLevel = measurePCM16(frame)
		b.inputLevelAt = time.Now()
		b.diagnosticFrames++
		b.diagnosticBytes += len(frame)
		b.mu.Unlock()
		b.voice.AppendInput(frame)
		time.Sleep(time.Duration(maximum(1, len(frame)/48)) * time.Millisecond)
	}
	err = b.voice.EndInput(ctx)
	b.mu.Lock()
	b.diagnosticActive = false
	b.voiceTurnActive = false
	b.mu.Unlock()
	return err
}

func (b *Bridge) SetManagementAudioDevice(label string) {
	if strings.TrimSpace(label) == "" {
		return
	}
	b.setAudioInputDevice(strings.TrimSpace(label), "management_page")
}

func (b *Bridge) HandleManagementAudio(frame []byte) {
	b.mu.Lock()
	active := b.diagnosticActive
	source := b.audioInputSource
	b.mu.Unlock()
	if !active || source != "mac" || len(frame) == 0 || len(frame)%2 != 0 || len(frame) > 64*1024 {
		return
	}
	b.mu.RLock()
	nativeActive := b.nativeCaptureActive
	b.mu.RUnlock()
	if nativeActive {
		return
	}
	level := measurePCM16(frame)
	b.mu.Lock()
	b.inputLevel = level
	b.inputLevelAt = time.Now()
	b.managementAudioAt = b.inputLevelAt
	b.audioInputTransport = "management_page"
	b.diagnosticFrames++
	b.diagnosticBytes += len(frame)
	b.mu.Unlock()
	b.voice.AppendInput(frame)
}

func (b *Bridge) AddManagementAudioSink(sink func([]byte)) func() {
	b.mu.Lock()
	b.nextSinkID++
	id := b.nextSinkID
	b.managementSinks[id] = sink
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		delete(b.managementSinks, id)
		b.mu.Unlock()
	}
}

func (b *Bridge) ResetPairing() (security.PairingSnapshot, error) {
	b.mu.RLock()
	ptt := b.anyPTTLocked()
	b.mu.RUnlock()
	if ptt {
		b.stopNativeInput()
		b.voice.AbortInput()
	}
	snapshot, err := b.pairing.Reset()
	if err != nil {
		return security.PairingSnapshot{}, err
	}
	b.mu.Lock()
	sessions := make([]*session, 0, len(b.sessions))
	for id, current := range b.sessions {
		if current.authenticated {
			sessions = append(sessions, current)
			delete(b.sessions, id)
		}
	}
	b.mu.Unlock()
	for _, current := range sessions {
		_ = current.transport.Close(4002, "pairing reset")
	}
	return snapshot, nil
}

func (b *Bridge) Attach(id string, transport Transport) {
	b.mu.Lock()
	b.sessions[id] = &session{transport: transport}
	b.mu.Unlock()
}

func (b *Bridge) Detach(id string) {
	b.mu.Lock()
	current := b.sessions[id]
	delete(b.sessions, id)
	ptt := current != nil && current.pttActive
	b.mu.Unlock()
	if ptt {
		b.stopNativeInput()
		b.voice.AbortInput()
	}
}

func (b *Bridge) HandleControl(ctx context.Context, id string, message protocol.ClientControl) error {
	b.mu.RLock()
	current := b.sessions[id]
	b.mu.RUnlock()
	if current == nil {
		return nil
	}
	if message.Type == "hello" {
		return b.authenticate(ctx, id, message)
	}
	b.mu.RLock()
	authenticated := current.authenticated
	b.mu.RUnlock()
	if !authenticated {
		return NewBridgeError("not_authenticated", "必须先发送 hello 完成认证", false)
	}
	if b.dedupe.IsDuplicate(message.RequestID) {
		return nil
	}
	switch message.Type {
	case "state_sync":
		for _, event := range b.journal.After(message.LastEventID) {
			_ = current.transport.SendControl(event)
		}
		return b.sendStateSync(ctx, current)
	case "ptt_start":
		b.mu.Lock()
		if !b.voiceChatActive {
			b.mu.Unlock()
			return NewBridgeError("voice_chat_inactive", "请先选择 Codex 会话并拨打电话", true)
		}
		if b.diagnosticActive {
			b.mu.Unlock()
			return NewBridgeError("audio_test_active", "电脑音频测试正在进行", true)
		}
		if current.pttActive {
			b.mu.Unlock()
			return NewBridgeError("ptt_already_active", "PTT 已经处于录音状态", true)
		}
		if b.audioResponseActive {
			b.audioResponseActive = false
			b.mu.Unlock()
			b.publish(b.journal.Create(map[string]any{"type": "assistant_audio_end"}, false))
		} else {
			b.mu.Unlock()
		}
		b.mu.Lock()
		current.pttActive = true
		b.mu.Unlock()
		if err := b.voice.BeginInput(ctx); err != nil {
			b.mu.Lock()
			current.pttActive = false
			b.mu.Unlock()
			return err
		}
		b.mu.RLock()
		source := b.audioInputSource
		b.mu.RUnlock()
		if source == "mac" {
			if err := b.startNativeInput(); err != nil {
				b.mu.Lock()
				current.pttActive = false
				b.mu.Unlock()
				b.voice.AbortInput()
				return NewBridgeError("microphone_unavailable", "Go 原生麦克风不可用："+err.Error(), true)
			}
		}
	case "ptt_end":
		b.mu.Lock()
		active := current.pttActive
		current.pttActive = false
		b.mu.Unlock()
		if active {
			b.stopNativeInput()
			return b.voice.EndInput(ctx)
		}
	case "voice_target_select":
		return b.SelectVoiceTarget(ctx, message.ThreadID)
	case "voice_target_new":
		return b.CreateVoiceTarget(ctx)
	case "task_command":
		_, _, err := b.codex.SendCommand(ctx, message.Text, message.ThreadID)
		return err
	case "task_interrupt":
		return b.codex.Interrupt(ctx, message.ThreadID)
	case "approval_decision":
		return b.codex.ResolveApproval(message.ApprovalRequestID, message.Decision)
	case "report_request":
		summary := b.codex.LatestFinal()
		if summary == "" {
			return NewBridgeError("no_summary", "当前没有可播报的完成汇报", true)
		}
		return b.voice.SpeakSummary(ctx, summary)
	case "image_request":
		image, err := b.images.Prepare(message.Path, message.Title)
		if err != nil {
			return err
		}
		b.publishImage(image)
	case "ping":
		_ = current.transport.SendControl(b.journal.Create(map[string]any{"type": "pong", "requestId": message.RequestID, "echoedSentAt": message.SentAt}, false))
	}
	return nil
}

func (b *Bridge) HandleBinary(id string, frame []byte) error {
	b.mu.RLock()
	current := b.sessions[id]
	inputSource := b.audioInputSource
	b.mu.RUnlock()
	if current == nil || !current.authenticated || !current.pttActive {
		return nil
	}
	kind, payload, err := protocol.DecodeBinaryFrame(frame)
	if err != nil {
		return NewBridgeError("bad_audio_frame", err.Error(), true)
	}
	if kind != protocol.ClientAudioFrame || len(payload) > 64*1024 || len(payload)%2 != 0 {
		return NewBridgeError("bad_audio_frame", "未知的或过大的音频帧", true)
	}
	if inputSource != "visor" {
		return nil
	}
	level := measurePCM16(payload)
	b.mu.Lock()
	b.inputLevel = level
	b.inputLevelAt = time.Now()
	b.diagnosticFrames++
	b.diagnosticBytes += len(payload)
	b.audioInputTransport = "visor"
	b.mu.Unlock()
	b.voice.AppendInput(payload)
	return nil
}

func (b *Bridge) SendError(id string, err error, requestID string) {
	b.mu.RLock()
	current := b.sessions[id]
	b.mu.RUnlock()
	if current == nil {
		return
	}
	bridgeErr := normalizeError(err)
	payload := map[string]any{"type": "error", "code": bridgeErr.Code, "message": bridgeErr.Message, "recoverable": bridgeErr.Recoverable}
	if requestID != "" {
		payload["requestId"] = requestID
	}
	_ = current.transport.SendControl(b.journal.Create(payload, false))
	if !bridgeErr.Recoverable {
		_ = current.transport.Close(1008, bridgeErr.Code)
	}
}

func (b *Bridge) authenticate(ctx context.Context, id string, hello protocol.ClientControl) error {
	b.mu.Lock()
	current := b.sessions[id]
	if current == nil {
		b.mu.Unlock()
		return nil
	}
	if current.authenticated {
		b.mu.Unlock()
		return NewBridgeError("already_authenticated", "连接已经认证", false)
	}
	b.mu.Unlock()
	var token string
	var err error
	if hello.Token != "" {
		if !b.pairing.IsTokenValid(hello.DeviceID, hello.Token) {
			return NewBridgeError("authentication_failed", "配对码或设备令牌无效", false)
		}
	} else {
		token, err = b.pairing.Pair(hello.DeviceID, hello.PairingCode)
		if err != nil {
			return err
		}
		if token == "" {
			return NewBridgeError("authentication_failed", "配对码或设备令牌无效", false)
		}
	}
	b.mu.Lock()
	for otherID, other := range b.sessions {
		if otherID != id && other.authenticated && other.deviceID == hello.DeviceID {
			if other.pttActive {
				b.voice.AbortInput()
			}
			_ = other.transport.Close(4001, "newer device connection")
			delete(b.sessions, otherID)
		}
	}
	current.authenticated = true
	current.deviceID = hello.DeviceID
	transport := current.transport
	b.mu.Unlock()
	ack := map[string]any{"type": "hello_ack", "requestId": hello.RequestID, "bridgeVersion": b.config.Version, "audioSampleRate": protocol.AudioSampleRate}
	if token != "" {
		ack["deviceToken"] = token
	}
	_ = transport.SendControl(b.journal.Create(ack, false))
	for _, event := range b.journal.After(hello.LastEventID) {
		_ = transport.SendControl(event)
	}
	return b.sendStateSync(ctx, current)
}

func (b *Bridge) sendStateSync(ctx context.Context, current *session) error {
	targets, err := b.codex.ListVoiceTargets(ctx)
	if err != nil {
		return err
	}
	b.mu.RLock()
	selected := nullableString(b.codex.SelectedThreadID())
	active := nullableString(b.codex.ActiveTurnID())
	voiceActive, phase := b.voiceChatActive, b.voiceChatPhase
	images := append([]protocol.ImageCard{}, b.imageCards...)
	pending := b.codex.PendingApproval()
	latest := b.codex.LatestFinal()
	b.mu.RUnlock()
	state := map[string]any{"type": "state_sync", "selectedThreadId": selected, "voiceChatActive": voiceActive, "voiceChatPhase": phase, "activeTurnId": active, "threads": targets, "pendingApproval": pending, "latestSummary": nullableString(latest), "images": images}
	return current.transport.SendControl(b.journal.Create(state, false))
}

func (b *Bridge) broadcastStateSync(ctx context.Context) error {
	b.mu.RLock()
	sessions := make([]*session, 0)
	for _, current := range b.sessions {
		if current.authenticated {
			sessions = append(sessions, current)
		}
	}
	b.mu.RUnlock()
	for _, current := range sessions {
		if err := b.sendStateSync(ctx, current); err != nil {
			b.logger.Warn("state sync failed", map[string]any{"error": err.Error()})
		}
	}
	return nil
}

func (b *Bridge) publish(message map[string]any) {
	b.mu.RLock()
	sessions := make([]*session, 0)
	for _, current := range b.sessions {
		if current.authenticated {
			sessions = append(sessions, current)
		}
	}
	b.mu.RUnlock()
	for _, current := range sessions {
		_ = current.transport.SendControl(message)
	}
}

func (b *Bridge) publishBinary(payload []byte) {
	frame := protocol.EncodeBinaryFrame(protocol.ServerAudioFrame, payload)
	b.mu.RLock()
	sessions := make([]*session, 0)
	for _, current := range b.sessions {
		if current.authenticated && current.transport != nil {
			sessions = append(sessions, current)
		}
	}
	b.mu.RUnlock()
	for _, current := range sessions {
		_ = current.transport.SendBinary(frame)
	}
}

func (b *Bridge) publishImage(image protocol.ImageCard) {
	b.mu.Lock()
	for index, current := range b.imageCards {
		if current.ID == image.ID {
			b.imageCards = append(b.imageCards[:index], b.imageCards[index+1:]...)
			break
		}
	}
	b.imageCards = append([]protocol.ImageCard{image}, b.imageCards...)
	if len(b.imageCards) > 20 {
		b.imageCards = b.imageCards[:20]
	}
	b.mu.Unlock()
	b.publish(b.journal.Create(map[string]any{"type": "image_card", "image": image}, true))
}

func (b *Bridge) handleVoiceAudio(audio []byte) {
	b.mu.RLock()
	if b.anyPTTLocked() {
		b.mu.RUnlock()
		return
	}
	output := b.localAudioOutput
	audioStarted := b.audioResponseActive
	b.mu.RUnlock()
	if !audioStarted {
		b.mu.Lock()
		b.audioResponseActive = true
		b.mu.Unlock()
		b.recordVoiceEvent(voiceDiagnosticEvent{Type: "audio_start"})
		b.publish(b.journal.Create(map[string]any{"type": "assistant_audio_start", "sampleRate": protocol.AudioSampleRate, "channels": protocol.AudioChannels, "encoding": protocol.AudioEncoding}, false))
	}
	if output != "mac_only" {
		b.publishBinary(audio)
	}
	nativePlayed := false
	if output != "visor_only" {
		nativePlayed = b.playNativeAudio(audio)
	}
	if output != "visor_only" && !nativePlayed {
		b.mu.RLock()
		sinks := make([]func([]byte), 0, len(b.managementSinks))
		for _, sink := range b.managementSinks {
			sinks = append(sinks, sink)
		}
		b.mu.RUnlock()
		for _, sink := range sinks {
			sink(audio)
		}
	}
}

func (b *Bridge) startNativeInput() error {
	b.nativeInputMu.Lock()
	defer b.nativeInputMu.Unlock()
	b.mu.Lock()
	if b.audioInputSource != "mac" || b.nativeCaptureActive {
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()
	capture, err := audio.NewCapture(func(pcm []byte) {
		b.mu.RLock()
		active := b.nativeCaptureActive && b.audioInputSource == "mac" && (b.diagnosticActive || b.anyPTTLocked())
		b.mu.RUnlock()
		if !active {
			return
		}
		b.mu.Lock()
		b.inputLevel = measurePCM16(pcm)
		b.inputLevelAt = time.Now()
		b.audioInputTransport = "native"
		b.diagnosticFrames++
		b.diagnosticBytes += len(pcm)
		b.mu.Unlock()
		b.voice.AppendInput(pcm)
	})
	if err != nil {
		return err
	}
	b.mu.Lock()
	if b.audioInputSource != "mac" || (!b.diagnosticActive && !b.anyPTTLocked()) {
		b.mu.Unlock()
		capture.Close()
		return nil
	}
	b.nativeCapture = capture
	b.nativeCaptureActive = true
	b.audioInputDevice = "Mac 默认麦克风"
	b.audioInputTransport = "native"
	b.mu.Unlock()
	if err := capture.Start(); err != nil {
		b.mu.Lock()
		b.nativeCaptureActive = false
		b.nativeCapture = nil
		b.mu.Unlock()
		capture.Close()
		return err
	}
	return nil
}

func (b *Bridge) stopNativeInput() {
	b.nativeInputMu.Lock()
	defer b.nativeInputMu.Unlock()
	b.mu.Lock()
	capture := b.nativeCapture
	b.nativeCapture = nil
	b.nativeCaptureActive = false
	if b.audioInputSource == "mac" {
		b.audioInputTransport = "none"
	}
	b.mu.Unlock()
	if capture != nil {
		capture.Close()
	}
}

func (b *Bridge) playNativeAudio(pcm []byte) bool {
	b.audioMu.Lock()
	defer b.audioMu.Unlock()
	if b.nativePlayerDisabled {
		return false
	}
	if b.nativePlayer == nil {
		player, err := audio.NewPlayer()
		if err != nil {
			b.nativePlayerDisabled = true
			b.logger.Warn("Go native audio output unavailable", map[string]any{"error": err.Error()})
			return false
		}
		b.nativePlayer = player
	}
	if err := b.nativePlayer.Play(pcm); err != nil {
		b.logger.Warn("Go native audio output failed", map[string]any{"error": err.Error()})
		return false
	}
	return true
}

func (b *Bridge) handleVoiceAudioEnd(transcript string) {
	b.mu.Lock()
	b.voiceTurnActive = false
	active := b.audioResponseActive
	b.audioResponseActive = false
	b.mu.Unlock()
	b.recordVoiceEvent(voiceDiagnosticEvent{Type: "audio_end"})
	if active {
		payload := map[string]any{"type": "assistant_audio_end"}
		if transcript != "" {
			payload["transcript"] = transcript
		}
		b.publish(b.journal.Create(payload, false))
	}
}

func (b *Bridge) handleVoiceCaption(role, text string) {
	b.recordVoiceEvent(voiceDiagnosticEvent{Type: "caption", Role: role, Text: text})
	b.publish(b.journal.Create(map[string]any{"type": "caption", "role": role, "text": text}, false))
}

func (b *Bridge) handleInputLevel(level protocol.AudioLevel) {
	b.mu.Lock()
	b.inputLevel = level
	b.inputLevelAt = time.Now()
	b.mu.Unlock()
}

func (b *Bridge) handleOutputLevel(level protocol.AudioLevel) {
	b.mu.Lock()
	b.outputLevel = level
	b.outputLevelAt = time.Now()
	b.mu.Unlock()
}

func (b *Bridge) setAudioInputDevice(label, transport string) {
	b.mu.Lock()
	b.audioInputDevice = label
	b.audioInputTransport = transport
	b.mu.Unlock()
}

func (b *Bridge) handleMicrophoneError(message string) {
	b.setAudioInputDevice("麦克风不可用："+message, "none")
	b.publishError("microphone_unavailable", "电脑麦克风不可用："+message, true)
}

func (b *Bridge) handleVoiceError(err error) {
	b.stopNativeInput()
	bridgeErr := normalizeError(err)
	b.mu.Lock()
	b.voiceTurnActive = false
	b.audioResponseActive = false
	b.voiceChatPhase = "error"
	b.voiceChatError = bridgeErr.Message
	b.mu.Unlock()
	b.recordVoiceEvent(voiceDiagnosticEvent{Type: "error", Text: bridgeErr.Message})
	b.publish(b.journal.Create(map[string]any{"type": "assistant_audio_end"}, false))
	b.publishError(bridgeErr.Code, bridgeErr.Message, bridgeErr.Recoverable)
}

func (b *Bridge) publishError(code, message string, recoverable bool) {
	b.publish(b.journal.Create(map[string]any{"type": "error", "code": code, "message": message, "recoverable": recoverable}, false))
}

func (b *Bridge) recordVoiceEvent(event voiceDiagnosticEvent) {
	b.mu.Lock()
	b.voiceEventID++
	event.ID = b.voiceEventID
	event.At = time.Now().UnixMilli()
	if event.Type == "caption" {
		for index := len(b.voiceEvents) - 1; index >= 0; index-- {
			previous := &b.voiceEvents[index]
			if previous.Type != "caption" || previous.Role != event.Role {
				continue
			}
			if event.Role == "user" || previous.Role == "assistant" {
				previous.Text = event.Text
				previous.At = event.At
				b.mu.Unlock()
				return
			}
		}
	}
	b.voiceEvents = append(b.voiceEvents, event)
	if len(b.voiceEvents) > 80 {
		b.voiceEvents = b.voiceEvents[len(b.voiceEvents)-80:]
	}
	b.mu.Unlock()
}

func (b *Bridge) assertVoiceTargetUnlocked() error {
	b.mu.RLock()
	active := b.voiceChatActive || b.voiceChatPhase == "starting" || b.voiceChatPhase == "stopping"
	b.mu.RUnlock()
	if active {
		return NewBridgeError("voice_chat_active", "通话中不能切换目标，请先挂断电话", true)
	}
	return nil
}

func (b *Bridge) anyPTTLocked() bool {
	for _, current := range b.sessions {
		if current.pttActive {
			return true
		}
	}
	return false
}

func (b *Bridge) anyAuthenticatedLocked() bool {
	for _, current := range b.sessions {
		if current.authenticated {
			return true
		}
	}
	return false
}

type BridgeError struct {
	Code        string
	Message     string
	Recoverable bool
}

func NewBridgeError(code, message string, recoverable bool) *BridgeError {
	return &BridgeError{Code: code, Message: message, Recoverable: recoverable}
}

func (e *BridgeError) Error() string { return e.Message }

func normalizeError(err error) *BridgeError {
	if err == nil {
		return NewBridgeError("internal_error", "unknown error", true)
	}
	var bridgeErr *BridgeError
	if errors.As(err, &bridgeErr) {
		return bridgeErr
	}
	var voiceErr *voice.VoiceError
	if errors.As(err, &voiceErr) {
		return NewBridgeError(voiceErr.Code, voiceErr.Message, voiceErr.Recoverable)
	}
	return NewBridgeError("internal_error", err.Error(), true)
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func measurePCM16(audio []byte) protocol.AudioLevel {
	count := len(audio) / 2
	if count == 0 {
		return protocol.AudioLevel{}
	}
	var sum, peak float64
	for index := 0; index < count; index++ {
		value := int16(binary.LittleEndian.Uint16(audio[index*2 : index*2+2]))
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
	if value <= 0 {
		return 0
	}
	x := value
	for index := 0; index < 8; index++ {
		x = (x + value/x) / 2
	}
	return x
}

func maximum(value, floor int) int {
	if value < floor {
		return floor
	}
	return value
}

func parseProbeWAV(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return nil, errors.New("probe hi there 音频不是有效 WAV")
	}
	format, audio := 0, []byte(nil)
	channels, sampleRate, bits := 0, 0, 0
	for offset := 12; offset+8 <= len(data); {
		chunkID := string(data[offset : offset+4])
		size := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start, end := offset+8, offset+8+size
		if end > len(data) {
			return nil, errors.New("probe hi there WAV 数据不完整")
		}
		switch chunkID {
		case "fmt ":
			if size >= 16 {
				format = int(binary.LittleEndian.Uint16(data[start : start+2]))
				channels = int(binary.LittleEndian.Uint16(data[start+2 : start+4]))
				sampleRate = int(binary.LittleEndian.Uint32(data[start+4 : start+8]))
				bits = int(binary.LittleEndian.Uint16(data[start+14 : start+16]))
			}
		case "data":
			audio = append([]byte(nil), data[start:end]...)
		}
		offset = end
		if size%2 != 0 {
			offset++
		}
	}
	if format != 1 || channels != 1 || sampleRate != protocol.AudioSampleRate || bits != 16 || len(audio) == 0 {
		return nil, fmt.Errorf("probe hi there WAV 必须是 24 kHz 单声道 PCM16")
	}
	return audio, nil
}
