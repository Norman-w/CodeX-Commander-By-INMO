package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFromDefaultsAndValidation(t *testing.T) {
	root := t.TempDir()
	getenv := func(key string) string {
		switch key {
		case "COMMANDER_CWD":
			return ""
		case "COMMANDER_PORT", "COMMANDER_AUTO_SELECT_LATEST", "COMMANDER_NETWORK_ACCESS", "COMMANDER_MEDIA_ROOTS":
			return ""
		default:
			return ""
		}
	}
	c, err := LoadFrom(getenv, func() (string, error) { return root, nil })
	if err != nil {
		t.Fatal(err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if c.CWD != resolvedRoot || c.Port != 8787 || c.Host != "127.0.0.1" || !c.AutoSelectLatest || c.NetworkAccess {
		t.Fatalf("unexpected defaults: %#v", c)
	}
	if c.AppServerMode != "gui_shared" || c.RealtimeTransport != "auto" || c.RealtimeVoice != "juniper" || c.AudioInputSource != "mac" || c.AudioOutputTargets != (AudioOutputTargets{Bridge: true, Visor: true}) {
		t.Fatalf("unexpected bridge defaults: %#v", c)
	}
}

func TestParseAudioOutputTargets(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want AudioOutputTargets
	}{
		{name: "all", raw: "bridge,web,visor", want: AudioOutputTargets{Bridge: true, Web: true, Visor: true}},
		{name: "none", raw: "none", want: AudioOutputTargets{}},
		{name: "trim and deduplicate", raw: " bridge,visor,bridge ", want: AudioOutputTargets{Bridge: true, Visor: true}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ParseAudioOutputTargets(test.raw)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("got %#v, want %#v", got, test.want)
			}
		})
	}
	if _, err := ParseAudioOutputTargets("speakers"); err == nil {
		t.Fatal("expected unknown output target to fail")
	}
}

func TestLoadFromRejectsInvalidRealtimeTransport(t *testing.T) {
	root := t.TempDir()
	values := map[string]string{"COMMANDER_REALTIME_TRANSPORT": "browser"}
	if _, err := LoadFrom(func(key string) string { return values[key] }, func() (string, error) { return root, nil }); err == nil {
		t.Fatal("expected invalid realtime transport to fail")
	}
}

func TestLoadFromUsesGoRuntimeDirectoryFromRepositoryRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "mac-bridge-go"), 0o755); err != nil {
		t.Fatal(err)
	}
	getenv := func(key string) string {
		if key == "COMMANDER_CWD" {
			return ""
		}
		return ""
	}
	c, err := LoadFrom(getenv, func() (string, error) { return root, nil })
	if err != nil {
		t.Fatal(err)
	}
	runtimeDir := filepath.Join(root, "mac-bridge-go")
	if c.RuntimeDir != runtimeDir || c.MediaRoot != filepath.Join(runtimeDir, "media") || c.PairingFile != filepath.Join(runtimeDir, "data", "pairing.json") {
		t.Fatalf("unexpected runtime paths: %#v", c)
	}
}

func TestLoadFromKeepsLegacyProbeAudioUsableDuringMigration(t *testing.T) {
	root := t.TempDir()
	legacyData := filepath.Join(root, "mac-bridge", "data")
	if err := os.MkdirAll(legacyData, 0o755); err != nil {
		t.Fatal(err)
	}
	legacyProbe := filepath.Join(legacyData, "probe-hi-there-24k-mono.wav")
	if err := os.WriteFile(legacyProbe, []byte("RIFF"), 0o600); err != nil {
		t.Fatal(err)
	}
	getenv := func(key string) string { return "" }
	c, err := LoadFrom(getenv, func() (string, error) { return root, nil })
	if err != nil {
		t.Fatal(err)
	}
	resolvedLegacyProbe, err := filepath.EvalSymlinks(legacyProbe)
	if err != nil {
		t.Fatal(err)
	}
	if c.ProbeAudioPath != resolvedLegacyProbe {
		t.Fatalf("expected legacy probe fallback, got %q", c.ProbeAudioPath)
	}
}

func TestLoadFromRejectsInvalidBooleanAndCWD(t *testing.T) {
	root := t.TempDir()
	values := map[string]string{"COMMANDER_AUTO_SELECT_LATEST": "sometimes"}
	getenv := func(key string) string { return values[key] }
	if _, err := LoadFrom(getenv, func() (string, error) { return root, nil }); err == nil {
		t.Fatal("expected invalid boolean to fail")
	}
	values = map[string]string{"COMMANDER_CWD": filepath.Join(root, "missing")}
	if _, err := LoadFrom(func(key string) string { return values[key] }, func() (string, error) { return root, nil }); err == nil {
		t.Fatal("expected missing cwd to fail")
	}
}

func TestLoadDotEnvDoesNotOverwriteEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("CODEX_TEST_CONFIG=from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	const key = "CODEX_TEST_CONFIG"
	previous := os.Getenv(key)
	defer os.Setenv(key, previous)
	_ = os.Unsetenv(key)
	if err := LoadDotEnv(path); err != nil {
		t.Fatal(err)
	}
	if os.Getenv(key) != "from-file" {
		t.Fatalf("dotenv was not loaded: %q", os.Getenv(key))
	}
	if err := os.Setenv(key, "from-env"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("CODEX_TEST_CONFIG=changed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := LoadDotEnv(path); err != nil {
		t.Fatal(err)
	}
	if os.Getenv(key) != "from-env" {
		t.Fatalf("dotenv overwrote environment: %q", os.Getenv(key))
	}
}
