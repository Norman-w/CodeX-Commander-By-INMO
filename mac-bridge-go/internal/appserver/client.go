package appserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/norman-w/codex-commander-go/internal/config"
	"github.com/norman-w/codex-commander-go/internal/log"
)

type RPCID struct {
	Raw json.RawMessage
}

func (id RPCID) String() string {
	return strings.TrimSpace(string(id.Raw))
}

func NumberID(value int64) RPCID {
	return RPCID{Raw: json.RawMessage(strconv.FormatInt(value, 10))}
}

type Notification struct {
	Method string
	Params map[string]any
}

type ServerRequest struct {
	ID     RPCID
	Method string
	Params map[string]any
}

type Handlers struct {
	Notification func(Notification)
	Request      func(ServerRequest)
	Closed       func(error)
}

type Launch struct {
	Mode       string
	CodexBin   string
	Args       []string
	SocketPath string
}

type response struct {
	result any
	err    error
}

type Client struct {
	launch   Launch
	logger   *log.Logger
	handlers Handlers

	mu        sync.Mutex
	writeMu   sync.Mutex
	pending   map[string]chan response
	nextID    int64
	closed    bool
	transport rpcTransport
	process   *exec.Cmd
	stdin     io.WriteCloser

	stopOnce sync.Once
	stopCh   chan struct{}
}

type rpcTransport interface {
	WriteMessage([]byte) error
	ReadMessage() ([]byte, error)
	Close() error
}

func ResolveCodexBin(configured string) string {
	if configured != "codex" {
		if info, err := os.Stat(configured); err == nil && !info.IsDir() {
			return configured
		}
	}
	if info, err := os.Stat("/Applications/ChatGPT.app/Contents/Resources/codex"); err == nil && !info.IsDir() {
		return "/Applications/ChatGPT.app/Contents/Resources/codex"
	}
	return configured
}

func DefaultControlSocket() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".codex", "app-server-control", "app-server-control.sock")
	}
	return filepath.Join(home, ".codex", "app-server-control", "app-server-control.sock")
}

func ResolveLaunch(c config.Config) (Launch, error) {
	codexBin := ResolveCodexBin(c.CodexBin)
	if c.AppServerMode == "stdio" {
		return Launch{Mode: "stdio", CodexBin: codexBin, Args: []string{"app-server", "--stdio", "--enable", "realtime_conversation"}}, nil
	}
	socket := c.AppServerSocket
	if socket == "" {
		socket = DefaultControlSocket()
	}
	socket, err := filepath.Abs(socket)
	if err != nil {
		return Launch{}, err
	}
	if _, err := os.Stat(socket); err != nil {
		return Launch{}, fmt.Errorf("无法附着到 Codex app-server control socket %s: %w", socket, err)
	}
	return Launch{Mode: "unix-websocket", CodexBin: codexBin, SocketPath: socket}, nil
}

func NewClient(launch Launch, logger *log.Logger, handlers Handlers) *Client {
	return &Client{launch: launch, logger: logger, handlers: handlers, pending: make(map[string]chan response), nextID: 1, stopCh: make(chan struct{})}
}

func (c *Client) Start(ctx context.Context) error {
	c.mu.Lock()
	if c.transport != nil {
		c.mu.Unlock()
		return nil
	}
	c.closed = false
	c.mu.Unlock()

	if err := c.open(ctx); err != nil {
		return err
	}
	go c.readLoop()
	if _, err := c.Request(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "codex_commander_inmo_go", "title": "CodeX Commander By INMO Go", "version": "0.1.0"},
		"capabilities": map[string]any{"experimentalApi": true},
	}); err != nil {
		_ = c.Stop()
		return err
	}
	if err := c.Notify("initialized", map[string]any{}); err != nil {
		_ = c.Stop()
		return err
	}
	return nil
}

func (c *Client) open(ctx context.Context) error {
	if c.launch.Mode == "stdio" {
		cmd := exec.CommandContext(ctx, c.launch.CodexBin, c.launch.Args...)
		cmd.Env = sanitizedEnvironment(os.Environ())
		stdin, err := cmd.StdinPipe()
		if err != nil {
			return err
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			return err
		}
		if err := cmd.Start(); err != nil {
			return err
		}
		c.mu.Lock()
		c.process = cmd
		c.stdin = stdin
		c.transport = &stdioTransport{reader: bufio.NewReader(stdout), writer: stdin}
		c.mu.Unlock()
		go c.logStderr(stderr)
		return nil
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 8 * time.Second,
		NetDialContext: func(dialCtx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(dialCtx, "unix", c.launch.SocketPath)
		},
	}
	endpoint := &url.URL{Scheme: "ws", Host: "localhost", Path: "/"}
	conn, _, err := dialer.DialContext(ctx, endpoint.String(), nil)
	if err != nil {
		return fmt.Errorf("control socket 连接失败: %w", err)
	}
	c.mu.Lock()
	c.transport = &websocketTransport{conn: conn}
	c.mu.Unlock()
	return nil
}

func (c *Client) logStderr(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			c.logger.Debug("codex stderr", map[string]any{"line": line})
		}
	}
}

func (c *Client) Request(parent context.Context, method string, params map[string]any) (any, error) {
	return c.RequestTimeout(parent, method, params, 30*time.Second)
}

func (c *Client) RequestTimeout(parent context.Context, method string, params map[string]any, timeout time.Duration) (any, error) {
	c.mu.Lock()
	if c.closed || c.transport == nil {
		c.mu.Unlock()
		return nil, errors.New("Codex App Server is not running")
	}
	id := NumberID(c.nextID)
	c.nextID++
	key := id.String()
	waiter := make(chan response, 1)
	c.pending[key] = waiter
	c.mu.Unlock()

	message := map[string]any{"id": json.RawMessage(id.Raw), "method": method}
	if params != nil {
		message["params"] = params
	}
	if err := c.write(message); err != nil {
		c.mu.Lock()
		delete(c.pending, key)
		c.mu.Unlock()
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	select {
	case result := <-waiter:
		return result.result, result.err
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, key)
		c.mu.Unlock()
		return nil, fmt.Errorf("Codex request timed out: %s: %w", method, ctx.Err())
	}
}

func (c *Client) Notify(method string, params map[string]any) error {
	message := map[string]any{"method": method}
	if params != nil {
		message["params"] = params
	}
	return c.write(message)
}

func (c *Client) Respond(id RPCID, result any) error {
	return c.write(map[string]any{"id": json.RawMessage(id.Raw), "result": result})
}

func (c *Client) RespondError(id RPCID, code int, message string) error {
	return c.write(map[string]any{"id": json.RawMessage(id.Raw), "error": map[string]any{"code": code, "message": message}})
}

func (c *Client) write(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	transport := c.transport
	closed := c.closed
	c.mu.Unlock()
	if closed || transport == nil {
		return errors.New("Codex App Server is not running")
	}
	return transport.WriteMessage(data)
}

func (c *Client) readLoop() {
	for {
		c.mu.Lock()
		transport := c.transport
		c.mu.Unlock()
		if transport == nil {
			return
		}
		data, err := transport.ReadMessage()
		if err != nil {
			c.failAll(err)
			return
		}
		c.handleMessage(data)
	}
}

func (c *Client) handleMessage(data []byte) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(data, &envelope); err != nil {
		c.logger.Warn("Ignoring non-JSON Codex output", map[string]any{"error": err.Error()})
		return
	}
	idRaw, hasID := envelope["id"]
	methodRaw, hasMethod := envelope["method"]
	if hasID && (envelope["result"] != nil || envelope["error"] != nil) {
		key := strings.TrimSpace(string(idRaw))
		c.mu.Lock()
		waiter := c.pending[key]
		delete(c.pending, key)
		c.mu.Unlock()
		if waiter == nil {
			return
		}
		if errorRaw := envelope["error"]; errorRaw != nil && string(errorRaw) != "null" {
			var rpcErr struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			}
			_ = json.Unmarshal(errorRaw, &rpcErr)
			waiter <- response{err: fmt.Errorf("Codex JSON-RPC %d: %s", rpcErr.Code, rpcErr.Message)}
			return
		}
		var result any
		if resultRaw := envelope["result"]; resultRaw != nil {
			_ = json.Unmarshal(resultRaw, &result)
		}
		waiter <- response{result: result}
		return
	}
	if !hasMethod {
		return
	}
	var method string
	if err := json.Unmarshal(methodRaw, &method); err != nil || method == "" {
		return
	}
	var params map[string]any
	if raw := envelope["params"]; raw != nil {
		_ = json.Unmarshal(raw, &params)
	}
	if hasID {
		if c.handlers.Request != nil {
			go c.handlers.Request(ServerRequest{ID: RPCID{Raw: append(json.RawMessage(nil), idRaw...)}, Method: method, Params: params})
		}
		return
	}
	if c.handlers.Notification != nil {
		c.handlers.Notification(Notification{Method: method, Params: params})
	}
}

func (c *Client) failAll(err error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	pending := c.pending
	c.pending = make(map[string]chan response)
	c.mu.Unlock()
	for _, waiter := range pending {
		waiter <- response{err: err}
	}
	if c.handlers.Closed != nil {
		c.handlers.Closed(err)
	}
}

func (c *Client) Stop() error {
	var result error
	c.stopOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		transport := c.transport
		process := c.process
		c.transport = nil
		pending := c.pending
		c.pending = make(map[string]chan response)
		c.mu.Unlock()
		for _, waiter := range pending {
			waiter <- response{err: errors.New("Codex App Server stopped")}
		}
		if transport != nil {
			result = transport.Close()
		}
		if process != nil {
			if c.stdin != nil {
				_ = c.stdin.Close()
			}
			if err := process.Wait(); err != nil && !strings.Contains(err.Error(), "signal: killed") {
				result = err
			}
		}
		close(c.stopCh)
	})
	return result
}

type stdioTransport struct {
	reader *bufio.Reader
	writer io.Writer
	mu     sync.Mutex
}

func (s *stdioTransport) WriteMessage(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.writer.Write(append(data, '\n'))
	return err
}

func (s *stdioTransport) ReadMessage() ([]byte, error) {
	line, err := s.reader.ReadBytes('\n')
	if len(line) > 0 {
		return []byte(strings.TrimSpace(string(line))), nil
	}
	return nil, err
}

func (s *stdioTransport) Close() error { return nil }

type websocketTransport struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (w *websocketTransport) WriteMessage(data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteMessage(websocket.TextMessage, data)
}

func (w *websocketTransport) ReadMessage() ([]byte, error) {
	messageType, data, err := w.conn.ReadMessage()
	if err != nil {
		return nil, err
	}
	if messageType != websocket.TextMessage {
		return nil, errors.New("Codex app-server sent a non-text websocket frame")
	}
	return data, nil
}

func (w *websocketTransport) Close() error { return w.conn.Close() }

func sanitizedEnvironment(entries []string) []string {
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if key == "COMMANDER_PAIRING_FILE" || key == "COMMANDER_ORIGIN_ALLOWLIST" || key == "COMMANDER_TAILSCALE_BIN" {
			continue
		}
		if key == "OPENAI_API_KEY" {
			continue
		}
		if strings.HasPrefix(key, "COMMANDER_") && key != "COMMANDER_CWD" {
			continue
		}
		result = append(result, entry)
	}
	return result
}
