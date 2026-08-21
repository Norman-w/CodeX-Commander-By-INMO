package codex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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
	commanderThreadSource    = "codex_commander_inmo"
	voiceSessionSequenceFile = "voice-session-sequence.txt"
)

var voiceSessionNamePattern = regexp.MustCompile(`^No\.([0-9]+) [0-9]{2}-[0-9]{2}$`)
var realtimeInputPattern = regexp.MustCompile(`(?s)<input>\s*(.*?)\s*</input>`)
var internalTagPattern = regexp.MustCompile(`<[^>]+>`)

type TaskEvent struct {
	ThreadID string
	TurnID   string
	Phase    string
	Message  string
	Final    bool
}

type Callbacks struct {
	TaskEvent         func(TaskEvent)
	ApprovalRequested func(protocol.ApprovalCard)
	ApprovalResolved  func(string, string)
	ImageFound        func(string, string)
	Notification      func(appserver.Notification)
}

type threadRecord struct {
	ID           string
	Name         string
	Preview      string
	UpdatedAt    int64
	ThreadSource string
	Status       map[string]any
	Turns        []any
	CWD          string
}

type pendingApproval struct {
	id          appserver.RPCID
	permissions any
	card        protocol.ApprovalCard
	timer       *time.Timer
}

type Controller struct {
	config    config.Config
	logger    *log.Logger
	callbacks Callbacks
	launch    *appserver.Launch

	voiceSessionSequenceMu     sync.Mutex
	voiceSessionSequenceLoaded bool
	voiceSessionNextNumber     int

	mu                   sync.RWMutex
	client               *appserver.Client
	selectedThreadID     string
	selectedThread       *protocol.ThreadSummary
	activeTurnID         string
	latestFinal          string
	summaries            map[string]string
	pendingApproval      *pendingApproval
	notificationHandlers map[int]func(appserver.Notification)
	nextHandlerID        int
	progressBuffer       string
	progressThreadID     string
	progressTurnID       string
	progressTimer        *time.Timer
}

func New(c config.Config, logger *log.Logger, callbacks Callbacks) *Controller {
	return &Controller{config: c, logger: logger, callbacks: callbacks, summaries: make(map[string]string), notificationHandlers: make(map[int]func(appserver.Notification))}
}

func NewWithLaunch(c config.Config, logger *log.Logger, callbacks Callbacks, launch appserver.Launch) *Controller {
	controller := New(c, logger, callbacks)
	controller.launch = &launch
	return controller
}

func (c *Controller) Start(ctx context.Context) error {
	launch := c.launch
	if launch == nil {
		resolved, err := appserver.ResolveLaunch(c.config)
		if err != nil {
			return err
		}
		launch = &resolved
	}
	c.logger.Info("Connecting to Codex app-server", map[string]any{"mode": launch.Mode})
	client := appserver.NewClient(*launch, c.logger, appserver.Handlers{
		Notification: c.handleNotification,
		Request:      c.handleServerRequest,
		Closed: func(err error) {
			c.logger.Warn("Codex app-server closed", map[string]any{"error": err.Error()})
		},
	})
	c.mu.Lock()
	c.client = client
	c.mu.Unlock()
	if err := client.Start(ctx); err != nil {
		c.mu.Lock()
		c.client = nil
		c.mu.Unlock()
		return err
	}
	accountValue, err := client.Request(ctx, "account/read", map[string]any{})
	if err != nil {
		_ = client.Stop()
		return err
	}
	if account, ok := accountValue.(map[string]any); ok {
		requires, _ := account["requiresOpenaiAuth"].(bool)
		if requires && account["account"] == nil {
			_ = client.Stop()
			return errors.New("Codex 尚未登录，请先在 Mac 上打开 Codex 完成登录")
		}
	}
	if c.config.ThreadID != "" && c.logger != nil {
		c.logger.Info("Ignoring COMMANDER_THREAD_ID during startup; explicit session selection is required", map[string]any{"threadId": c.config.ThreadID})
	}
	if c.config.AutoSelectLatest {
		threads, listErr := c.ListThreads(ctx)
		if listErr == nil {
			for _, thread := range threads {
				if thread.Status != "working" && thread.Status != "waiting_approval" {
					_ = c.selectThread(ctx, thread.ID, false)
					break
				}
			}
		}
	}
	return nil
}

func (c *Controller) Stop() error {
	c.mu.Lock()
	if c.progressTimer != nil {
		c.progressTimer.Stop()
		c.progressTimer = nil
	}
	pending := c.pendingApproval
	c.pendingApproval = nil
	client := c.client
	c.client = nil
	c.mu.Unlock()
	if pending != nil && client != nil {
		_ = client.Respond(pending.id, denyResponse(pending.method()))
		if pending.timer != nil {
			pending.timer.Stop()
		}
	}
	if client != nil {
		return client.Stop()
	}
	return nil
}

func (c *Controller) SelectedThreadID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.selectedThreadID
}

func (c *Controller) ActiveTurnID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.activeTurnID
}

func (c *Controller) LatestFinal() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.latestFinal
}

func (c *Controller) PendingApproval() *protocol.ApprovalCard {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.pendingApproval == nil {
		return nil
	}
	card := c.pendingApproval.card
	return &card
}

func (c *Controller) RequestJSONRPC(ctx context.Context, method string, params map[string]any, timeout time.Duration) (any, error) {
	c.mu.RLock()
	client := c.client
	c.mu.RUnlock()
	if client == nil {
		return nil, errors.New("Codex App Server is not running")
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return client.RequestTimeout(ctx, method, params, timeout)
}

func (c *Controller) SubscribeNotifications(handler func(appserver.Notification)) func() {
	c.mu.Lock()
	c.nextHandlerID++
	id := c.nextHandlerID
	c.notificationHandlers[id] = handler
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		delete(c.notificationHandlers, id)
		c.mu.Unlock()
	}
}

func (c *Controller) EnsureSelectedThread(ctx context.Context) (string, error) {
	c.mu.RLock()
	selected := c.selectedThreadID
	c.mu.RUnlock()
	if selected != "" {
		return selected, nil
	}
	params := map[string]any{
		"cwd":               c.config.CWD,
		"approvalPolicy":    c.config.ApprovalPolicy,
		"approvalsReviewer": "user",
		"sandbox":           c.config.Sandbox,
		"serviceName":       "codex_commander_inmo",
		"threadSource":      commanderThreadSource,
		"config":            realtimeSessionConfig(),
	}
	if c.config.CodexModel != "" {
		params["model"] = c.config.CodexModel
	}
	result, err := c.RequestJSONRPC(ctx, "thread/start", params, 30*time.Second)
	if err != nil {
		return "", err
	}
	thread := parseThread(mapValue(result, "thread"))
	if thread.ID == "" {
		return "", errors.New("thread/start returned no thread id")
	}
	name, err := c.nextVoiceSessionName(ctx)
	if err != nil {
		return "", err
	}
	_, _ = c.RequestJSONRPC(ctx, "thread/name/set", map[string]any{"threadId": thread.ID, "name": name}, 30*time.Second)
	summary := c.threadSummary(thread)
	summary.Title = name
	c.mu.Lock()
	c.selectedThreadID = thread.ID
	c.selectedThread = &summary
	c.latestFinal = ""
	c.mu.Unlock()
	return thread.ID, nil
}

func (c *Controller) nextVoiceSessionName(ctx context.Context) (string, error) {
	c.voiceSessionSequenceMu.Lock()
	defer c.voiceSessionSequenceMu.Unlock()

	if !c.voiceSessionSequenceLoaded {
		next, err := c.loadVoiceSessionNextNumber(ctx)
		if err != nil {
			return "", err
		}
		c.voiceSessionNextNumber = next
		c.voiceSessionSequenceLoaded = true
	}

	number := c.voiceSessionNextNumber
	if number < 1 {
		number = 1
	}
	next := number + 1
	if err := c.saveVoiceSessionNextNumber(next); err != nil {
		return "", err
	}
	c.voiceSessionNextNumber = next
	return formatVoiceSessionName(number, time.Now()), nil
}

func (c *Controller) loadVoiceSessionNextNumber(ctx context.Context) (int, error) {
	next := 1
	sequencePath := filepath.Join(c.config.RuntimeDir, "data", voiceSessionSequenceFile)
	data, err := os.ReadFile(sequencePath)
	if err == nil {
		stored, parseErr := strconv.Atoi(strings.TrimSpace(string(data)))
		if parseErr == nil && stored > next {
			next = stored
		} else if parseErr != nil && c.logger != nil {
			c.logger.Warn("Voice session sequence file is invalid; rebuilding from Codex threads", map[string]any{"path": sequencePath, "error": parseErr.Error()})
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, fmt.Errorf("read voice session sequence: %w", err)
	}

	// The file keeps the counter monotonic across restarts and archives. When
	// it does not exist yet, also inspect existing names so an upgrade cannot
	// reuse a number that was already assigned manually or by an older build.
	records, listErr := c.listThreadRecords(ctx)
	if listErr != nil {
		if c.logger != nil {
			c.logger.Warn("Could not inspect existing voice session names; starting from persisted sequence", map[string]any{"error": listErr.Error()})
		}
		return next, nil
	}
	for _, record := range records {
		if number, ok := parseVoiceSessionNumber(record.Name); ok && number >= next {
			next = number + 1
		}
	}
	return next, nil
}

func (c *Controller) saveVoiceSessionNextNumber(next int) error {
	if next < 1 {
		return errors.New("voice session sequence must be positive")
	}
	sequenceDir := filepath.Join(c.config.RuntimeDir, "data")
	if err := os.MkdirAll(sequenceDir, 0o700); err != nil {
		return fmt.Errorf("create voice session sequence directory: %w", err)
	}
	temporary, err := os.CreateTemp(sequenceDir, ".voice-session-sequence-*")
	if err != nil {
		return fmt.Errorf("create voice session sequence file: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.WriteString(strconv.Itoa(next) + "\n"); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write voice session sequence: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close voice session sequence: %w", err)
	}
	sequencePath := filepath.Join(sequenceDir, voiceSessionSequenceFile)
	if err := os.Rename(temporaryName, sequencePath); err != nil {
		return fmt.Errorf("replace voice session sequence: %w", err)
	}
	return nil
}

func parseVoiceSessionNumber(name string) (int, bool) {
	match := voiceSessionNamePattern.FindStringSubmatch(strings.TrimSpace(name))
	if len(match) != 2 {
		return 0, false
	}
	number, err := strconv.Atoi(match[1])
	return number, err == nil && number > 0
}

func formatVoiceSessionName(number int, now time.Time) string {
	return fmt.Sprintf("No.%02d %s", number, now.Format("01-02"))
}

func (c *Controller) StartVoiceThread(ctx context.Context) (string, error) {
	records, err := c.listThreadRecords(ctx)
	if err != nil {
		return "", err
	}
	for _, record := range records {
		if isCommanderThreadSource(record.ThreadSource) {
			if err := c.resumeThread(ctx, record.ID); err == nil {
				return record.ID, nil
			}
		}
	}
	c.mu.Lock()
	c.selectedThreadID = ""
	c.selectedThread = nil
	c.activeTurnID = ""
	c.mu.Unlock()
	return c.EnsureSelectedThread(ctx)
}

func (c *Controller) ListThreads(ctx context.Context) ([]protocol.ThreadSummary, error) {
	records, err := c.listThreadRecords(ctx)
	if err != nil {
		return nil, err
	}
	selected := c.SelectedThreadID()
	summaries := make([]protocol.ThreadSummary, 0, len(records))
	for _, record := range records {
		if !isCommanderThreadSource(record.ThreadSource) {
			continue
		}
		summaries = append(summaries, c.threadSummary(record))
	}
	result := deduplicateThreadSummaries(summaries, selected)
	c.mu.RLock()
	if c.selectedThread != nil {
		found := false
		for _, summary := range result {
			if summary.ID == c.selectedThread.ID {
				found = true
				break
			}
		}
		if !found {
			result = append([]protocol.ThreadSummary{*c.selectedThread}, result...)
		}
	}
	c.mu.RUnlock()
	return result, nil
}

func (c *Controller) ListVoiceTargets(ctx context.Context) ([]protocol.ThreadSummary, error) {
	records, err := c.listThreadRecords(ctx)
	if err != nil {
		return nil, err
	}
	summaries := make([]protocol.ThreadSummary, 0, len(records)+1)
	for _, record := range records {
		summaries = append(summaries, c.threadSummary(record))
	}
	selectedID := c.SelectedThreadID()
	result := deduplicateThreadSummaries(summaries, selectedID)
	c.mu.RLock()
	selected := c.selectedThread
	c.mu.RUnlock()
	if selected != nil {
		found := false
		for _, summary := range result {
			if summary.ID == selected.ID {
				found = true
				break
			}
		}
		if !found {
			result = append([]protocol.ThreadSummary{*selected}, result...)
		}
	}
	return result, nil
}

func deduplicateThreadSummaries(summaries []protocol.ThreadSummary, selectedID string) []protocol.ThreadSummary {
	unique := make(map[string]protocol.ThreadSummary, len(summaries))
	orderedKeys := make([]string, 0, len(summaries))
	for _, summary := range summaries {
		key := threadSummaryKey(summary)
		if old, ok := unique[key]; !ok {
			unique[key] = summary
			orderedKeys = append(orderedKeys, key)
		} else if summary.ID == selectedID && old.ID != selectedID {
			unique[key] = summary
		}
	}
	result := make([]protocol.ThreadSummary, 0, len(unique))
	for _, key := range orderedKeys {
		result = append(result, unique[key])
	}
	return result
}

func threadSummaryKey(summary protocol.ThreadSummary) string {
	title := strings.ToLower(strings.Join(strings.Fields(summary.Title), " "))
	preview := strings.ToLower(strings.Join(strings.Fields(summary.Preview), " "))
	if title == "" && preview == "" {
		return "id\x00" + summary.ID
	}
	return title + "\x00" + preview
}

func (c *Controller) ArchiveVoiceTargets(ctx context.Context) (int, error) {
	c.mu.RLock()
	activeTurn := c.activeTurnID
	c.mu.RUnlock()
	if activeTurn != "" {
		return 0, errors.New("Codex 正在执行，完成后才能清理通话会话")
	}
	records, err := c.listThreadRecords(ctx)
	if err != nil {
		return 0, err
	}
	ids := make([]string, 0, len(records))
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		if record.ID == "" {
			continue
		}
		if _, ok := seen[record.ID]; ok {
			continue
		}
		seen[record.ID] = struct{}{}
		ids = append(ids, record.ID)
	}
	archived := 0
	for _, id := range ids {
		if _, err := c.RequestJSONRPC(ctx, "thread/archive", map[string]any{"threadId": id}, 30*time.Second); err != nil {
			return archived, fmt.Errorf("归档 Codex 通话会话 %s 失败: %w", id, err)
		}
		archived++
	}
	c.mu.Lock()
	c.selectedThreadID = ""
	c.selectedThread = nil
	c.latestFinal = ""
	c.mu.Unlock()
	return archived, nil
}

func (c *Controller) SelectThread(ctx context.Context, id string) error {
	return c.selectThread(ctx, id, true)
}

func (c *Controller) SelectVoiceTarget(ctx context.Context, id string) error {
	c.mu.RLock()
	active := c.activeTurnID
	c.mu.RUnlock()
	if active != "" {
		return errors.New("Codex 正在执行，完成或中断后才能切换通话目标")
	}
	records, err := c.listThreadRecords(ctx)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record.ID == id {
			return c.resumeThread(ctx, id)
		}
	}
	return errors.New("该 Codex 会话不属于当前配置的工作目录")
}

func (c *Controller) CreateNewThread(ctx context.Context) (protocol.ThreadSummary, error) {
	c.mu.RLock()
	active := c.activeTurnID
	c.mu.RUnlock()
	if active != "" {
		return protocol.ThreadSummary{}, errors.New("Codex 正在执行，完成或中断后才能新建通话会话")
	}
	c.mu.Lock()
	c.selectedThreadID = ""
	c.selectedThread = nil
	c.activeTurnID = ""
	c.latestFinal = ""
	c.mu.Unlock()
	id, err := c.EnsureSelectedThread(ctx)
	if err != nil {
		return protocol.ThreadSummary{}, err
	}
	targets, err := c.ListVoiceTargets(ctx)
	if err != nil {
		return protocol.ThreadSummary{}, err
	}
	for _, target := range targets {
		if target.ID == id {
			return target, nil
		}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.selectedThread != nil {
		return *c.selectedThread, nil
	}
	return protocol.ThreadSummary{}, errors.New("新 Codex 会话创建后无法读取会话信息")
}

func (c *Controller) SendCommand(ctx context.Context, text, requestedThreadID string) (string, string, error) {
	if requestedThreadID != "" && requestedThreadID != c.SelectedThreadID() {
		if err := c.SelectThread(ctx, requestedThreadID); err != nil {
			return "", "", err
		}
	}
	threadID, err := c.EnsureSelectedThread(ctx)
	if err != nil {
		return "", "", err
	}
	c.mu.RLock()
	active := c.activeTurnID
	c.mu.RUnlock()
	if active != "" {
		result, requestErr := c.RequestJSONRPC(ctx, "turn/steer", map[string]any{"threadId": threadID, "expectedTurnId": active, "input": []any{map[string]any{"type": "text", "text": text, "text_elements": []any{}}}}, 30*time.Second)
		if requestErr != nil {
			return "", "", requestErr
		}
		turnID := stringValue(mapValue(result, "turnId"))
		if turnID == "" {
			turnID = active
		}
		c.emitTask(TaskEvent{ThreadID: threadID, TurnID: turnID, Phase: "working", Message: "已把补充指令交给正在执行的 Codex", Final: false})
		return threadID, turnID, nil
	}
	params := map[string]any{
		"threadId":          threadID,
		"input":             []any{map[string]any{"type": "text", "text": text, "text_elements": []any{}}},
		"cwd":               c.config.CWD,
		"approvalPolicy":    c.config.ApprovalPolicy,
		"approvalsReviewer": "user",
		"sandboxPolicy":     c.sandboxPolicy(),
	}
	if c.config.CodexModel != "" {
		params["model"] = c.config.CodexModel
	}
	result, err := c.RequestJSONRPC(ctx, "turn/start", params, 30*time.Second)
	if err != nil {
		return "", "", err
	}
	turnID := stringValue(mapValue(mapValue(result, "turn"), "id"))
	c.mu.Lock()
	c.activeTurnID = turnID
	c.latestFinal = ""
	c.mu.Unlock()
	c.emitTask(TaskEvent{ThreadID: threadID, TurnID: turnID, Phase: "working", Message: "已交给 Codex，正在执行", Final: false})
	return threadID, turnID, nil
}

func (c *Controller) Interrupt(ctx context.Context, requestedThreadID string) error {
	threadID := requestedThreadID
	if threadID == "" {
		threadID = c.SelectedThreadID()
	}
	turnID := c.ActiveTurnID()
	if threadID == "" || turnID == "" {
		return errors.New("No active Codex turn to interrupt")
	}
	_, err := c.RequestJSONRPC(ctx, "turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID}, 30*time.Second)
	return err
}

func (c *Controller) ResolveApproval(requestID, decision string) error {
	c.mu.Lock()
	pending := c.pendingApproval
	if pending == nil || pending.card.RequestID != requestID {
		c.mu.Unlock()
		return errors.New("Approval is no longer pending")
	}
	c.pendingApproval = nil
	if pending.timer != nil {
		pending.timer.Stop()
	}
	client := c.client
	c.mu.Unlock()
	if client == nil {
		return errors.New("Codex App Server is not running")
	}
	if err := client.Respond(pending.id, approvalResponse(pending.method(), pending.permissions, decision)); err != nil {
		return err
	}
	c.emitApprovalResolved(requestID, decision)
	return nil
}

func (c *Controller) handleNotification(notification appserver.Notification) {
	params := notification.Params
	switch notification.Method {
	case "item/agentMessage/delta":
		delta := stringValue(params["delta"])
		if delta != "" {
			threadID := stringOr(params["threadId"], c.SelectedThreadID())
			c.appendProgress(threadID, stringValue(params["turnId"]), delta)
		}
	case "item/completed":
		item := mapValue(params, "item")
		threadID := stringOr(params["threadId"], c.SelectedThreadID())
		if stringValue(item["type"]) == "agentMessage" && stringValue(item["text"]) != "" && stringValue(item["phase"]) != "commentary" {
			summary := privacy.SanitizeForVisor(stringValue(item["text"]), 16_000, []string{c.config.CWD})
			c.mu.Lock()
			c.summaries[threadID] = summary
			if threadID == c.selectedThreadID {
				c.latestFinal = summary
			}
			c.mu.Unlock()
		}
		if stringValue(item["type"]) == "imageView" && stringValue(item["path"]) != "" && c.callbacks.ImageFound != nil {
			c.callbacks.ImageFound(stringValue(item["path"]), "Codex 图片")
		}
		if stringValue(item["type"]) == "imageGeneration" && stringValue(item["savedPath"]) != "" && c.callbacks.ImageFound != nil {
			c.callbacks.ImageFound(stringValue(item["savedPath"]), "Codex 生成图片")
		}
	case "turn/started":
		threadID := stringOr(params["threadId"], c.SelectedThreadID())
		turnID := stringValue(mapValue(params, "turn")["id"])
		c.mu.Lock()
		if turnID != "" {
			c.activeTurnID = turnID
		}
		if threadID != "" {
			c.selectedThreadID = threadID
		}
		c.mu.Unlock()
	case "turn/completed":
		c.flushProgress()
		threadID := stringOr(params["threadId"], c.SelectedThreadID())
		turn := mapValue(params, "turn")
		turnID := stringValue(turn["id"])
		status := stringValue(turn["status"])
		phase := "completed"
		fallback := "任务已完成"
		if status == "interrupted" {
			phase, fallback = "interrupted", "任务已中断"
		} else if status == "failed" {
			phase, fallback = "failed", "任务失败：请在 Mac 上查看详情"
			if message := stringValue(mapValue(turn, "error")["message"]); message != "" {
				fallback = "任务失败：" + message
			}
		}
		c.mu.RLock()
		summary := c.summaries[threadID]
		active := c.activeTurnID
		c.mu.RUnlock()
		if summary == "" {
			summary = fallback
		}
		if turnID == "" {
			turnID = active
		}
		c.mu.Lock()
		if threadID == c.selectedThreadID {
			c.latestFinal = c.summaries[threadID]
		}
		c.activeTurnID = ""
		c.mu.Unlock()
		c.emitTask(TaskEvent{ThreadID: threadID, TurnID: turnID, Phase: phase, Message: privacy.SanitizeForVisor(summary, 4_000, []string{c.config.CWD}), Final: true})
	case "serverRequest/resolved":
		requestID := stringValue(params["requestId"])
		if requestID == "" {
			requestID = fmt.Sprint(params["requestId"])
		}
		c.mu.Lock()
		if c.pendingApproval != nil && c.pendingApproval.card.RequestID == requestID {
			if c.pendingApproval.timer != nil {
				c.pendingApproval.timer.Stop()
			}
			c.pendingApproval = nil
			c.mu.Unlock()
			c.emitApprovalResolved(requestID, "resolved_elsewhere")
		} else {
			c.mu.Unlock()
		}
	}

	c.mu.RLock()
	handlers := make([]func(appserver.Notification), 0, len(c.notificationHandlers))
	for _, handler := range c.notificationHandlers {
		handlers = append(handlers, handler)
	}
	c.mu.RUnlock()
	for _, handler := range handlers {
		handler(notification)
	}
	if c.callbacks.Notification != nil {
		c.callbacks.Notification(notification)
	}
}

func (c *Controller) handleServerRequest(request appserver.ServerRequest) {
	if request.Method != "item/commandExecution/requestApproval" && request.Method != "item/fileChange/requestApproval" && request.Method != "item/permissions/requestApproval" {
		c.mu.RLock()
		client := c.client
		c.mu.RUnlock()
		if client != nil {
			_ = client.RespondError(request.ID, -32601, "CodeX Commander does not support this interactive request")
		}
		return
	}
	c.mu.Lock()
	if c.pendingApproval != nil {
		client := c.client
		c.mu.Unlock()
		if client != nil {
			_ = client.Respond(request.ID, denyResponse(request.Method))
		}
		return
	}
	params := request.Params
	kind := "file_change"
	if strings.Contains(request.Method, "commandExecution") {
		kind = "command"
	} else if strings.Contains(request.Method, "permissions") {
		kind = "permissions"
	}
	detail := stringValue(params["command"])
	if detail == "" {
		detail = stringOr(params["reason"], map[string]string{"command": "Codex 请求执行命令", "permissions": "Codex 请求额外权限", "file_change": "Codex 请求修改文件"}[kind])
	}
	if grantRoot := stringValue(params["grantRoot"]); grantRoot != "" {
		detail += "\n写入范围：" + grantRoot
	}
	if kind == "permissions" {
		detail += describePermissions(params["permissions"])
	}
	detail = privacy.RedactSecrets(detail)
	threadID := stringOr(params["threadId"], c.selectedThreadID)
	turnID := stringOr(params["turnId"], c.activeTurnID)
	card := protocol.ApprovalCard{RequestID: request.ID.String(), Kind: kind, Title: map[string]string{"command": "确认执行命令", "permissions": "确认额外权限", "file_change": "确认修改文件"}[kind], Detail: privacy.SanitizeForVisor(detail, 4_000, []string{c.config.CWD}), ThreadID: threadID, TurnID: turnID, ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
	pending := &pendingApproval{id: request.ID, permissions: params["permissions"], card: card}
	pending.timer = time.AfterFunc(time.Minute, func() {
		c.mu.Lock()
		if c.pendingApproval == nil || c.pendingApproval.card.RequestID != card.RequestID {
			c.mu.Unlock()
			return
		}
		c.pendingApproval = nil
		client := c.client
		c.mu.Unlock()
		if client != nil {
			_ = client.Respond(request.ID, denyResponse(request.Method))
		}
		c.emitApprovalResolved(card.RequestID, "expired")
	})
	c.pendingApproval = pending
	c.mu.Unlock()
	if c.callbacks.ApprovalRequested != nil {
		c.callbacks.ApprovalRequested(card)
	}
}

func (c *Controller) listThreadRecords(ctx context.Context) ([]threadRecord, error) {
	result, err := c.RequestJSONRPC(ctx, "thread/list", map[string]any{"limit": 100, "sortKey": "updated_at", "sortDirection": "desc", "archived": false, "cwd": c.config.CWD, "sourceKinds": []string{"cli", "vscode", "appServer", "unknown"}}, 30*time.Second)
	if err != nil {
		return nil, err
	}
	data := threadItems(result)
	threads := make([]threadRecord, 0, len(data))
	for _, item := range data {
		threads = append(threads, parseThread(item))
	}
	return threads, nil
}

func (c *Controller) selectThread(ctx context.Context, id string, validate bool) error {
	c.mu.RLock()
	active := c.activeTurnID
	c.mu.RUnlock()
	if active != "" {
		return errors.New("Codex 正在执行，完成或中断后才能切换任务")
	}
	if validate {
		threads, err := c.ListThreads(ctx)
		if err != nil {
			return err
		}
		found := false
		for _, thread := range threads {
			if thread.ID == id {
				found = true
				break
			}
		}
		if !found {
			return errors.New("该任务不属于当前配置的 Codex 工作目录")
		}
	}
	return c.resumeThread(ctx, id)
}

func (c *Controller) resumeThread(ctx context.Context, id string) error {
	result, err := c.RequestJSONRPC(ctx, "thread/resume", map[string]any{"threadId": id, "cwd": c.config.CWD, "approvalPolicy": c.config.ApprovalPolicy, "approvalsReviewer": "user", "sandbox": c.config.Sandbox}, 30*time.Second)
	if err != nil {
		return err
	}
	thread := parseThread(mapValue(result, "thread"))
	summary := c.threadSummary(thread)
	latest := privacy.SanitizeForVisor(latestSummary(thread), 16_000, []string{c.config.CWD})
	active := ""
	for i := len(thread.Turns) - 1; i >= 0; i-- {
		turn := asMap(thread.Turns[i])
		if stringValue(turn["status"]) == "inProgress" {
			active = stringValue(turn["id"])
			break
		}
	}
	c.mu.Lock()
	c.selectedThreadID = id
	c.selectedThread = &summary
	c.activeTurnID = active
	c.latestFinal = latest
	if latest != "" {
		c.summaries[id] = latest
	}
	c.mu.Unlock()
	return nil
}

func (c *Controller) threadSummary(thread threadRecord) protocol.ThreadSummary {
	statusType := stringValue(thread.Status["type"])
	status := "unknown"
	if statusType == "active" {
		status = "working"
		for _, flag := range stringSlice(thread.Status["activeFlags"]) {
			if flag == "waitingOnApproval" {
				status = "waiting_approval"
			}
		}
	} else if statusType == "systemError" {
		status = "failed"
	} else if statusType == "idle" || statusType == "notLoaded" || statusType == "" {
		status = "idle"
	}
	preview := cleanThreadPreview(thread.Preview, c.config.CWD)
	title := privacy.SanitizeForVisor(firstNonEmpty(thread.Name, preview, "未命名 Codex 任务"), 240, []string{c.config.CWD})
	return protocol.ThreadSummary{ID: thread.ID, Title: title, Preview: preview, Status: status, UpdatedAt: thread.UpdatedAt}
}

func (c *Controller) appendProgress(threadID, turnID, delta string) {
	c.mu.Lock()
	if c.progressBuffer != "" && (threadID != c.progressThreadID || turnID != c.progressTurnID) {
		c.flushProgressLocked()
	}
	c.progressThreadID, c.progressTurnID = threadID, turnID
	c.progressBuffer = truncateRunes(c.progressBuffer+delta, 4_000)
	if c.progressTimer == nil {
		c.progressTimer = time.AfterFunc(300*time.Millisecond, func() { c.flushProgress() })
	}
	c.mu.Unlock()
}

func (c *Controller) flushProgress() {
	c.mu.Lock()
	c.flushProgressLocked()
	c.mu.Unlock()
}

func (c *Controller) flushProgressLocked() {
	if c.progressTimer != nil {
		c.progressTimer.Stop()
		c.progressTimer = nil
	}
	if c.progressBuffer == "" {
		return
	}
	message := privacy.SanitizeForVisor(c.progressBuffer, 4_000, []string{c.config.CWD})
	message = strings.Join(strings.Fields(message), " ")
	if len([]rune(message)) > 900 {
		message = "…" + string([]rune(message)[len([]rune(message))-899:])
	}
	event := TaskEvent{ThreadID: c.progressThreadID, TurnID: c.progressTurnID, Phase: "progress", Message: message, Final: false}
	c.progressBuffer = ""
	go c.emitTask(event)
}

func (c *Controller) emitTask(event TaskEvent) {
	if c.callbacks.TaskEvent != nil {
		c.callbacks.TaskEvent(event)
	}
}

func (c *Controller) emitApprovalResolved(requestID, resolution string) {
	if c.callbacks.ApprovalResolved != nil {
		c.callbacks.ApprovalResolved(requestID, resolution)
	}
}

func (c *Controller) commanderSource() string {
	if c.config.ContextBindingID != "" {
		return commanderThreadSource + ":" + c.config.ContextBindingID
	}
	return commanderThreadSource
}

func (c *Controller) sandboxPolicy() map[string]any {
	switch c.config.Sandbox {
	case "danger-full-access":
		return map[string]any{"type": "dangerFullAccess"}
	case "read-only":
		return map[string]any{"type": "readOnly", "networkAccess": false}
	default:
		return map[string]any{"type": "workspaceWrite", "writableRoots": []string{c.config.CWD}, "networkAccess": c.config.NetworkAccess, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false}
	}
}

func realtimeSessionConfig() map[string]any {
	return map[string]any{"features": map[string]any{"realtime_conversation": true}, "realtime": map[string]any{"version": "v3", "type": "conversational"}}
}

func isCommanderThreadSource(value string) bool {
	return value == commanderThreadSource || strings.HasPrefix(value, commanderThreadSource+":")
}

func parseThread(value any) threadRecord {
	thread := asMap(value)
	return threadRecord{ID: stringValue(thread["id"]), Name: stringValue(thread["name"]), Preview: stringValue(thread["preview"]), UpdatedAt: normalizeUnixMillis(int64Value(thread["updatedAt"])), ThreadSource: stringValue(thread["threadSource"]), Status: asMap(thread["status"]), Turns: anySlice(thread["turns"]), CWD: stringValue(thread["cwd"])}
}

func cleanThreadPreview(value, cwd string) string {
	value = privacy.SanitizeForVisor(value, 1_000, []string{cwd})
	if strings.Contains(value, "<realtime_delegation>") {
		matches := realtimeInputPattern.FindAllStringSubmatch(value, -1)
		if len(matches) > 0 {
			value = matches[len(matches)-1][1]
		} else {
			return ""
		}
	}
	value = internalTagPattern.ReplaceAllString(value, " ")
	value = strings.Join(strings.Fields(value), " ")
	return truncateRunes(value, 240)
}

func normalizeUnixMillis(value int64) int64 {
	if value > 0 && value < 1_000_000_000_000 {
		return value * 1_000
	}
	return value
}

func latestSummary(thread threadRecord) string {
	for i := len(thread.Turns) - 1; i >= 0; i-- {
		turn := asMap(thread.Turns[i])
		items := anySlice(turn["items"])
		for j := len(items) - 1; j >= 0; j-- {
			item := asMap(items[j])
			if stringValue(item["type"]) == "agentMessage" && stringValue(item["phase"]) != "commentary" && stringValue(item["text"]) != "" {
				return truncateRunes(stringValue(item["text"]), 16_000)
			}
		}
	}
	return ""
}

func approvalResponse(method string, requested any, decision string) map[string]any {
	if method == "item/permissions/requestApproval" {
		permissions := map[string]any{}
		if decision == "accept" {
			requestedMap := asMap(requested)
			if value, ok := requestedMap["network"].(map[string]any); ok {
				permissions["network"] = value
			}
			if value, ok := requestedMap["fileSystem"].(map[string]any); ok {
				permissions["fileSystem"] = value
			}
		}
		return map[string]any{"permissions": permissions, "scope": "turn"}
	}
	return map[string]any{"decision": decision}
}

func denyResponse(method string) map[string]any {
	return approvalResponse(method, nil, "decline")
}

func describePermissions(value any) string {
	permissions := asMap(value)
	parts := make([]string, 0)
	if network := asMap(permissions["network"]); network["enabled"] == true {
		parts = append(parts, "网络访问")
	}
	fileSystem := asMap(permissions["fileSystem"])
	for _, path := range stringSlice(fileSystem["read"]) {
		parts = append(parts, "读取 "+path)
	}
	for _, path := range stringSlice(fileSystem["write"]) {
		parts = append(parts, "写入 "+path)
	}
	if len(parts) == 0 {
		return "\n请求范围：未提供"
	}
	return "\n请求范围：" + strings.Join(parts, "；")
}

func (p *pendingApproval) method() string {
	if p.card.Kind == "command" {
		return "item/commandExecution/requestApproval"
	}
	if p.card.Kind == "permissions" {
		return "item/permissions/requestApproval"
	}
	return "item/fileChange/requestApproval"
}

func mapValue(value any, key string) map[string]any {
	return asMap(asMap(value)[key])
}

func threadItems(value any) []any {
	root := asMap(value)
	dataValue := root["data"]
	if data := asMap(dataValue); len(data) > 0 {
		if items := anySlice(data["items"]); items != nil {
			return items
		}
		if items := anySlice(data["data"]); items != nil {
			return items
		}
	}
	return anySlice(dataValue)
}

func asMap(value any) map[string]any {
	if result, ok := value.(map[string]any); ok && result != nil {
		return result
	}
	return map[string]any{}
}

func anySlice(value any) []any {
	result, _ := value.([]any)
	return result
}

func stringSlice(value any) []string {
	values, _ := value.([]any)
	result := make([]string, 0, len(values))
	for _, item := range values {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	if values == nil {
		if typed, ok := value.([]string); ok {
			return typed
		}
	}
	return result
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func stringOr(value any, fallback string) string {
	if text := stringValue(value); text != "" {
		return text
	}
	return fallback
}

func int64Value(value any) int64 {
	switch number := value.(type) {
	case float64:
		return int64(number)
	case int64:
		return number
	case int:
		return int64(number)
	}
	return 0
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func truncateRunes(value string, maximum int) string {
	runes := []rune(value)
	if len(runes) <= maximum {
		return value
	}
	return string(runes[:maximum])
}
