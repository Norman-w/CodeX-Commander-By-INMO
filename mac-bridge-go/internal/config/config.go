package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Host               string
	Port               int
	RuntimeDir         string
	CWD                string
	OriginAllowlist    map[string]struct{}
	PairingFile        string
	MediaRoot          string
	MediaRoots         []string
	AppServerMode      string
	AppServerSocket    string
	RealtimeTransport  string
	RealtimeVoice      string
	CodexBin           string
	ThreadID           string
	ContextBindingID   string
	AutoSelectLatest   bool
	CodexModel         string
	ApprovalPolicy     string
	Sandbox            string
	NetworkAccess      bool
	AudioInputSource   string
	AudioOutputTargets AudioOutputTargets
	RealtimeIdleMS     int
	LogLevel           string
	ProbeAudioPath     string
	Version            string
}

// AudioOutputTargets describes the independent destinations for assistant audio.
type AudioOutputTargets struct {
	Bridge bool `json:"bridge"`
	Web    bool `json:"web"`
	Visor  bool `json:"visor"`
}

func (targets AudioOutputTargets) Any() bool {
	return targets.Bridge || targets.Web || targets.Visor
}

func (targets AudioOutputTargets) String() string {
	if !targets.Any() {
		return "none"
	}
	values := make([]string, 0, 3)
	if targets.Bridge {
		values = append(values, "bridge")
	}
	if targets.Web {
		values = append(values, "web")
	}
	if targets.Visor {
		values = append(values, "visor")
	}
	return strings.Join(values, ",")
}

func ParseAudioOutputTargets(raw string) (AudioOutputTargets, error) {
	raw = strings.TrimSpace(strings.ToLower(raw))
	switch raw {
	case "none":
		return AudioOutputTargets{}, nil
	case "":
		return AudioOutputTargets{}, errors.New("audio output targets cannot be empty; use none")
	}

	var targets AudioOutputTargets
	for _, value := range strings.Split(raw, ",") {
		switch strings.TrimSpace(value) {
		case "bridge":
			targets.Bridge = true
		case "web":
			targets.Web = true
		case "visor":
			targets.Visor = true
		case "":
			continue
		default:
			return AudioOutputTargets{}, fmt.Errorf("invalid audio output target: %s", value)
		}
	}
	return targets, nil
}

func LoadDotEnv(path string) error {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" || os.Getenv(key) != "" {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		if err := os.Setenv(key, value); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func Load() (Config, error) {
	return LoadFrom(os.Getenv, os.Getwd)
}

func LoadFrom(getenv func(string) string, getwd func() (string, error)) (Config, error) {
	workingDir, err := getwd()
	if err != nil {
		return Config{}, err
	}
	root := getenv("COMMANDER_CWD")
	if root == "" {
		root = workingDir
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return Config{}, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return Config{}, fmt.Errorf("COMMANDER_CWD does not exist: %w", err)
	}
	runtimeDir := getenv("COMMANDER_RUNTIME_DIR")
	if runtimeDir == "" {
		if filepath.Base(workingDir) == "mac-bridge-go" {
			runtimeDir = workingDir
		} else if candidate := filepath.Join(workingDir, "mac-bridge-go"); directoryExists(candidate) {
			runtimeDir = candidate
		} else {
			runtimeDir = workingDir
		}
	}
	runtimeDir, err = filepath.Abs(runtimeDir)
	if err != nil {
		return Config{}, err
	}

	port := 8787
	if raw := getenv("COMMANDER_PORT"); raw != "" {
		port, err = strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("invalid COMMANDER_PORT: %q", raw)
		}
	}
	autoSelectLatest, err := parseBool(getenv("COMMANDER_AUTO_SELECT_LATEST"), true)
	if err != nil {
		return Config{}, fmt.Errorf("invalid COMMANDER_AUTO_SELECT_LATEST: %w", err)
	}
	networkAccess, err := parseBool(getenv("COMMANDER_NETWORK_ACCESS"), false)
	if err != nil {
		return Config{}, fmt.Errorf("invalid COMMANDER_NETWORK_ACCESS: %w", err)
	}
	pairingFile := getenv("COMMANDER_PAIRING_FILE")
	if pairingFile == "" {
		pairingFile = filepath.Join(runtimeDir, "data", "pairing.json")
	}
	mediaRoot := filepath.Join(runtimeDir, "media")
	probeAudioPath := getenv("COMMANDER_PROBE_AUDIO_PATH")
	if probeAudioPath == "" {
		const probeAudioName = "probe-hi-there-24k-mono.wav"
		probeAudioPath = filepath.Join(runtimeDir, "data", probeAudioName)
		if _, statErr := os.Stat(probeAudioPath); os.IsNotExist(statErr) {
			// Keep the existing local probe usable during the one-time runtime
			// directory migration; no external runtime is loaded.
			legacyProbe := filepath.Join(root, "mac-bridge", "data", probeAudioName)
			if _, legacyErr := os.Stat(legacyProbe); legacyErr == nil {
				probeAudioPath = legacyProbe
			}
		}
	} else {
		probeAudioPath = absolute(probeAudioPath, runtimeDir)
	}

	appServerMode := valueOr(getenv("COMMANDER_APP_SERVER_MODE"), "gui_shared")
	realtimeTransport := valueOr(getenv("COMMANDER_REALTIME_TRANSPORT"), "auto")
	audioOutputValue := valueOr(getenv("COMMANDER_AUDIO_OUTPUTS"), "bridge,visor")
	audioOutputTargets, err := ParseAudioOutputTargets(audioOutputValue)
	if err != nil {
		return Config{}, fmt.Errorf("invalid COMMANDER_AUDIO_OUTPUTS: %w", err)
	}
	c := Config{
		Host:               valueOr(getenv("COMMANDER_HOST"), "127.0.0.1"),
		Port:               port,
		RuntimeDir:         runtimeDir,
		CWD:                root,
		OriginAllowlist:    splitSet(getenv("COMMANDER_ORIGIN_ALLOWLIST")),
		PairingFile:        absolute(pairingFile, runtimeDir),
		MediaRoot:          mediaRoot,
		AppServerMode:      appServerMode,
		AppServerSocket:    getenv("COMMANDER_APP_SERVER_SOCKET"),
		RealtimeTransport:  realtimeTransport,
		RealtimeVoice:      valueOr(getenv("COMMANDER_REALTIME_VOICE"), "juniper"),
		CodexBin:           valueOr(getenv("COMMANDER_CODEX_BIN"), "codex"),
		ThreadID:           getenv("COMMANDER_THREAD_ID"),
		ContextBindingID:   getenv("COMMANDER_CONTEXT_BINDING_ID"),
		AutoSelectLatest:   autoSelectLatest,
		CodexModel:         getenv("COMMANDER_CODEX_MODEL"),
		ApprovalPolicy:     valueOr(getenv("COMMANDER_APPROVAL_POLICY"), "on-request"),
		Sandbox:            valueOr(getenv("COMMANDER_SANDBOX"), "workspace-write"),
		NetworkAccess:      networkAccess,
		AudioInputSource:   valueOr(getenv("COMMANDER_AUDIO_INPUT_SOURCE"), "mac"),
		AudioOutputTargets: audioOutputTargets,
		RealtimeIdleMS:     60_000,
		LogLevel:           valueOr(getenv("COMMANDER_LOG_LEVEL"), "info"),
		ProbeAudioPath:     probeAudioPath,
		Version:            "0.1.0-go",
	}
	if raw := getenv("COMMANDER_REALTIME_IDLE_MS"); raw != "" {
		c.RealtimeIdleMS, err = strconv.Atoi(raw)
		if err != nil || c.RealtimeIdleMS < 10_000 || c.RealtimeIdleMS > 600_000 {
			return Config{}, fmt.Errorf("invalid COMMANDER_REALTIME_IDLE_MS: %q", raw)
		}
	}
	if c.AppServerMode != "gui_shared" && c.AppServerMode != "stdio" {
		return Config{}, fmt.Errorf("COMMANDER_APP_SERVER_MODE must be gui_shared or stdio")
	}
	if c.RealtimeTransport != "auto" && c.RealtimeTransport != "webrtc" && c.RealtimeTransport != "websocket" {
		return Config{}, fmt.Errorf("COMMANDER_REALTIME_TRANSPORT must be auto, webrtc, or websocket")
	}
	if c.ApprovalPolicy != "untrusted" && c.ApprovalPolicy != "on-request" && c.ApprovalPolicy != "never" {
		return Config{}, fmt.Errorf("invalid COMMANDER_APPROVAL_POLICY: %s", c.ApprovalPolicy)
	}
	if c.Sandbox != "read-only" && c.Sandbox != "workspace-write" && c.Sandbox != "danger-full-access" {
		return Config{}, fmt.Errorf("invalid COMMANDER_SANDBOX: %s", c.Sandbox)
	}
	if c.AudioInputSource != "visor" && c.AudioInputSource != "mac" {
		return Config{}, fmt.Errorf("invalid COMMANDER_AUDIO_INPUT_SOURCE: %s", c.AudioInputSource)
	}
	c.MediaRoots = []string{root}
	for _, entry := range strings.Split(getenv("COMMANDER_MEDIA_ROOTS"), ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		resolved, resolveErr := filepath.EvalSymlinks(absolute(entry, workingDir))
		if resolveErr == nil {
			c.MediaRoots = append(c.MediaRoots, resolved)
		}
	}
	return c, nil
}

func directoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func absolute(value, base string) string {
	if filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return filepath.Join(base, value)
}

func splitSet(value string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, entry := range strings.Split(value, ",") {
		entry = strings.TrimSpace(entry)
		if entry != "" {
			result[entry] = struct{}{}
		}
	}
	return result
}

func parseBool(value string, fallback bool) (bool, error) {
	if value == "" {
		return fallback, nil
	}
	switch value {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("must be true or false")
	}
}
