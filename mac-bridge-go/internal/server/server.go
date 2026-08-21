package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/norman-w/codex-commander-go/internal/bridge"
	"github.com/norman-w/codex-commander-go/internal/config"
	"github.com/norman-w/codex-commander-go/internal/log"
	"github.com/norman-w/codex-commander-go/internal/protocol"
)

const (
	maxWebSocketPayload = 1_048_576
	maxJSONBody         = 32_768
)

type Server struct {
	config config.Config
	bridge *bridge.Bridge
	logger *log.Logger

	httpServer *http.Server
	handler    http.Handler
	upgrader   websocket.Upgrader
}

func New(c config.Config, b *bridge.Bridge, logger *log.Logger) *Server {
	s := &Server{config: c, bridge: b, logger: logger}
	s.upgrader = websocket.Upgrader{
		ReadBufferSize:    4_096,
		WriteBufferSize:   16 * 1024,
		EnableCompression: false,
		CheckOrigin:       s.originAllowed,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleHTTP)
	s.handler = mux
	s.httpServer = &http.Server{
		Addr:              net.JoinHostPort(c.Host, strconv.Itoa(c.Port)),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	return s
}

// Handler is exposed for httptest and embedding; Listen blocks on the configured address.
func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) Listen() error {
	s.logger.Info("Go Mac Bridge listening", map[string]any{"address": s.httpServer.Addr})
	err := s.httpServer.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) Close(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}

func (s *Server) handleHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/visor" && isWebSocketUpgrade(r) {
		s.handleVisorWebSocket(w, r)
		return
	}
	if r.URL.Path == "/v1/management-audio" && isWebSocketUpgrade(r) {
		s.handleManagementAudioWebSocket(w, r)
		return
	}

	switch r.URL.Path {
	case "/healthz":
		if r.Method == http.MethodGet {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
	case "/readyz":
		if r.Method == http.MethodGet {
			ready := s.bridge.IsReady()
			status := http.StatusOK
			if !ready {
				status = http.StatusServiceUnavailable
			}
			writeJSON(w, status, map[string]any{"ready": ready})
			return
		}
	case "/":
		if !isLocalRequest(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "management page is local-only"})
			return
		}
		if r.Method == http.MethodGet {
			writeHTML(w, managementPage)
			return
		}
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	case "/api/settings":
		if !s.requireLocal(w, r) {
			return
		}
		s.handleSettings(w, r)
		return
	case "/api/voice-chat/targets":
		if !s.requireLocal(w, r) {
			return
		}
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		state, err := s.bridge.GetVoiceTargetState(r.Context())
		if err != nil {
			s.writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
		return
	case "/api/voice-chat/targets/clear":
		if !s.requireLocal(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		archived, err := s.bridge.ArchiveVoiceTargets(r.Context())
		if err != nil {
			s.writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"archivedCount": archived})
		return
	case "/api/voice-chat/target":
		if !s.requireLocal(w, r) {
			return
		}
		s.handleVoiceTarget(w, r)
		return
	case "/api/voice-chat/start":
		if !s.requireLocal(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		if err := s.bridge.StartVoiceChat(r.Context()); err != nil {
			s.writeError(w, err)
			return
		}
		s.writeDiagnostics(w)
		return
	case "/api/voice-chat/stop":
		if !s.requireLocal(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		if err := s.bridge.StopVoiceChat(r.Context()); err != nil {
			s.writeError(w, err)
			return
		}
		s.writeDiagnostics(w)
		return
	case "/api/audio-levels":
		if !s.requireLocal(w, r) {
			return
		}
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		writeJSON(w, http.StatusOK, s.bridge.AudioDiagnostics())
		return
	case "/api/audio-test/start":
		if !s.requireLocal(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		if err := s.bridge.StartAudioTest(r.Context()); err != nil {
			s.writeError(w, err)
			return
		}
		s.writeDiagnostics(w)
		return
	case "/api/audio-test/stop":
		if !s.requireLocal(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		if err := s.bridge.StopAudioTest(r.Context()); err != nil {
			s.writeError(w, err)
			return
		}
		s.writeDiagnostics(w)
		return
	case "/api/audio-test/sample":
		if !s.requireLocal(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		if err := s.bridge.SendAudioTestSample(r.Context()); err != nil {
			s.writeError(w, err)
			return
		}
		s.writeDiagnostics(w)
		return
	}

	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/media/") {
		s.handleMedia(w, r)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{
			"audioInputSource": s.bridge.GetAudioInputSource(),
			"localAudioOutput": s.bridge.GetLocalAudioOutput(),
			"inputOptions":     []string{"visor", "mac"},
			"outputOptions":    []string{"visor_only", "mac_only", "mac_and_visor"},
		})
	case http.MethodPut:
		payload, err := readJSON(r)
		if err != nil {
			s.writeError(w, err)
			return
		}
		value, ok := payload.(map[string]any)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "request body must be an object"})
			return
		}
		input, inputSet := value["audioInputSource"]
		output, outputSet := value["localAudioOutput"]
		if legacy, ok := output.(bool); ok {
			output = map[bool]string{true: "mac_and_visor", false: "visor_only"}[legacy]
		}
		if inputSet {
			inputText, ok := input.(string)
			if !ok || (inputText != "visor" && inputText != "mac") {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "audioInputSource must be visor or mac"})
				return
			}
			s.bridge.SetAudioInputSource(inputText)
		}
		if outputSet {
			outputText, ok := output.(string)
			if !ok || (outputText != "visor_only" && outputText != "mac_only" && outputText != "mac_and_visor") {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "localAudioOutput must be visor_only, mac_only, or mac_and_visor"})
				return
			}
			s.bridge.SetLocalAudioOutput(outputText)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "audioInputSource": s.bridge.GetAudioInputSource(), "localAudioOutput": s.bridge.GetLocalAudioOutput()})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
	}
}

func (s *Server) handleVoiceTarget(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	payload, err := readJSON(r)
	if err != nil {
		s.writeError(w, err)
		return
	}
	value, ok := payload.(map[string]any)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请选择 Codex 会话或新建会话"})
		return
	}
	if value["newSession"] == true {
		err = s.bridge.CreateVoiceTarget(r.Context())
	} else if threadID, ok := value["threadId"].(string); ok && strings.TrimSpace(threadID) != "" {
		err = s.bridge.SelectVoiceTarget(r.Context(), strings.TrimSpace(threadID))
	} else {
		err = bridge.NewBridgeError("invalid_voice_target", "请选择 Codex 会话或新建会话", true)
	}
	if err != nil {
		s.writeError(w, err)
		return
	}
	state, err := s.bridge.GetVoiceTargetState(r.Context())
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (s *Server) writeDiagnostics(w http.ResponseWriter) {
	value := s.bridge.AudioDiagnostics()
	value["ok"] = true
	writeJSON(w, http.StatusOK, value)
}

func (s *Server) handleMedia(w http.ResponseWriter, r *http.Request) {
	deviceID := r.Header.Get("X-Device-ID")
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") || !s.bridge.ValidateMediaToken(deviceID, strings.TrimPrefix(authorization, "Bearer ")) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	filename := filepath.Base(r.URL.Path)
	if r.URL.Path != "/media/"+filename || len(filename) != 29 || !strings.HasSuffix(filename, ".webp") {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	for _, char := range filename[:24] {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
			return
		}
	}
	path := filepath.Join(s.config.MediaRoot, filename)
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Cache-Control", "private, max-age=86400, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, path)
}

func (s *Server) handleVisorWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxWebSocketPayload)
	transport := &socketTransport{conn: conn}
	id := randomID()
	s.bridge.Attach(id, transport)
	defer func() {
		s.bridge.Detach(id)
		_ = transport.Close(1000, "connection closed")
	}()

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	receivedHello := false
	jobs := make(chan controlJob, 64)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		for job := range jobs {
			if err := s.bridge.HandleControl(context.Background(), id, job.message); err != nil {
				s.bridge.SendError(id, err, job.message.RequestID)
			}
		}
	}()

	for {
		messageType, data, readErr := conn.ReadMessage()
		if readErr != nil {
			break
		}
		if messageType == websocket.BinaryMessage {
			if err := s.bridge.HandleBinary(id, data); err != nil {
				s.bridge.SendError(id, err, "")
			}
			continue
		}
		if messageType != websocket.TextMessage {
			continue
		}
		message, parseErr := protocol.ParseClientControl(data)
		if parseErr != nil {
			s.bridge.SendError(id, parseErr, "")
			continue
		}
		if !receivedHello && message.Type != "hello" {
			s.bridge.SendError(id, bridge.NewBridgeError("hello_required", "第一条消息必须是 hello", false), message.RequestID)
			continue
		}
		if message.Type == "hello" {
			receivedHello = true
			_ = conn.SetReadDeadline(time.Time{})
		}
		select {
		case jobs <- controlJob{message: message}:
		case <-workerDone:
			return
		}
	}
	close(jobs)
	<-workerDone
}

func (s *Server) handleManagementAudioWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxWebSocketPayload)
	transport := &socketTransport{conn: conn}
	removeSink := s.bridge.AddManagementAudioSink(func(pcm []byte) {
		_ = transport.SendBinary(pcm)
	})
	defer func() {
		removeSink()
		_ = transport.Close(1000, "connection closed")
	}()
	for {
		messageType, data, readErr := conn.ReadMessage()
		if readErr != nil {
			return
		}
		if messageType == websocket.BinaryMessage {
			s.bridge.HandleManagementAudio(data)
			continue
		}
		if messageType != websocket.TextMessage {
			continue
		}
		var message struct {
			Type  string `json:"type"`
			Label string `json:"label"`
		}
		if json.Unmarshal(data, &message) == nil && message.Type == "device" {
			s.bridge.SetManagementAudioDevice(message.Label)
		}
	}
}

type controlJob struct{ message protocol.ClientControl }

type socketTransport struct {
	conn *websocket.Conn
	mu   sync.Mutex
	dead bool
}

func (s *socketTransport) SendControl(value map[string]any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return errors.New("websocket is closed")
	}
	return s.conn.WriteMessage(websocket.TextMessage, data)
}

func (s *socketTransport) SendBinary(value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return errors.New("websocket is closed")
	}
	return s.conn.WriteMessage(websocket.BinaryMessage, value)
}

func (s *socketTransport) Close(code int, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return nil
	}
	s.dead = true
	_ = s.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
	return s.conn.Close()
}

func (s *Server) requireLocal(w http.ResponseWriter, r *http.Request) bool {
	if isLocalRequest(r) {
		return true
	}
	writeJSON(w, http.StatusForbidden, map[string]any{"error": "management page is local-only"})
	return false
}

func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || len(s.config.OriginAllowlist) == 0 {
		return true
	}
	_, ok := s.config.OriginAllowlist[origin]
	return ok
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") && strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func isLocalRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = strings.Trim(r.RemoteAddr, "[]")
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func readJSON(r *http.Request) (any, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, maxJSONBody)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("request body is too large or unreadable: %w", err)
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, errors.New("request body is not valid JSON")
	}
	return value, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		status = http.StatusInternalServerError
		data = []byte(`{"error":"could not encode response"}`)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(append(data, '\n'))
}

func writeHTML(w http.ResponseWriter, value string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, value)
}

func (s *Server) writeError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	value := map[string]any{"error": err.Error()}
	var bridgeErr *bridge.BridgeError
	if errors.As(err, &bridgeErr) {
		value["code"] = bridgeErr.Code
		value["recoverable"] = bridgeErr.Recoverable
	}
	writeJSON(w, status, value)
}

func randomID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return hex.EncodeToString(bytes[:])
	}
	return fmt.Sprintf("%x", time.Now().UnixNano())
}
