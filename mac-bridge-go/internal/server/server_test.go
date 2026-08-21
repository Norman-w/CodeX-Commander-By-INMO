package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/norman-w/codex-commander-go/internal/bridge"
	"github.com/norman-w/codex-commander-go/internal/config"
	"github.com/norman-w/codex-commander-go/internal/log"
)

func TestHTTPManagementAndHealthRoutes(t *testing.T) {
	c := testConfig(t)
	b := bridge.New(c, log.New("error"))
	s := New(c, b, log.New("error"))
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()

	response, err := http.Get(httpServer.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health status: %d", response.StatusCode)
	}
	_ = response.Body.Close()

	response, err = http.Get(httpServer.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	page, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("management page status: %d", response.StatusCode)
	}
	for _, marker := range []string{"CodeX Commander Bridge 音频诊断", "signal-rail", "call-orb", "voiceTarget", "BRIDGE 本地", "指挥中心网页", "INMO AIR3", "audioOutputTargets"} {
		if !strings.Contains(string(page), marker) {
			t.Fatalf("management page missing legacy marker %q", marker)
		}
	}

	response, err = http.Get(httpServer.URL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("ready status: %d", response.StatusCode)
	}
	_ = response.Body.Close()

	response, err = http.Get(httpServer.URL + "/api/settings")
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	if err := json.NewDecoder(response.Body).Decode(&settings); err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || settings["audioInputSource"] != "mac" {
		t.Fatalf("unexpected settings response: status=%d body=%#v", response.StatusCode, settings)
	}

	request, err := http.NewRequest(http.MethodPut, httpServer.URL+"/api/settings", strings.NewReader(`{"audioInputSource":"visor","audioOutputTargets":{"bridge":false,"web":true,"visor":false}}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("content-type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var updated map[string]any
	if err := json.NewDecoder(response.Body).Decode(&updated); err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || updated["audioInputSource"] != "visor" {
		t.Fatalf("unexpected updated settings response: status=%d body=%#v", response.StatusCode, updated)
	}
	outputs, ok := updated["audioOutputTargets"].(map[string]any)
	if !ok || outputs["bridge"] != false || outputs["web"] != true || outputs["visor"] != false {
		t.Fatalf("unexpected updated output targets: %#v", updated["audioOutputTargets"])
	}

	response, err = http.Post(httpServer.URL+"/api/settings", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("method status: %d", response.StatusCode)
	}
	_ = response.Body.Close()

	response, err = http.Get(httpServer.URL + "/media/000000000000000000000000.webp")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("media auth status: %d", response.StatusCode)
	}
	_ = response.Body.Close()
}

func TestVisorWebSocketPairsWithoutBrowserTransport(t *testing.T) {
	c := testConfig(t)
	b := bridge.New(c, log.New("error"))
	_, _ = b.Start(context.Background()) // Initializes pairing; app-server is intentionally absent in this protocol test.
	s := New(c, b, log.New("error"))
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()

	wsURL := "ws" + httpServer.URL[len("http"):]
	conn, _, err := websocket.DefaultDialer.Dial(wsURL+"/v1/visor", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	snapshot := b.PairingSnapshot()
	hello := map[string]any{
		"type":        "hello",
		"protocol":    "visor.v1",
		"requestId":   "550e8400-e29b-41d4-a716-446655440000",
		"deviceId":    "air3-device",
		"deviceName":  "AIR3",
		"appVersion":  "1.0",
		"pairingCode": snapshot.Code,
	}
	if err := conn.WriteJSON(hello); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := json.Unmarshal(data, &ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "hello_ack" || ack["deviceToken"] == nil {
		t.Fatalf("unexpected hello response: %#v", ack)
	}
}

func testConfig(t *testing.T) config.Config {
	t.Helper()
	root := t.TempDir()
	return config.Config{
		Host:               "127.0.0.1",
		Port:               8787,
		CWD:                root,
		PairingFile:        filepath.Join(root, "data", "pairing.json"),
		MediaRoot:          filepath.Join(root, "media"),
		MediaRoots:         []string{root},
		AppServerMode:      "gui_shared",
		AppServerSocket:    filepath.Join(root, "missing.sock"),
		CodexBin:           "codex",
		AudioInputSource:   "mac",
		AudioOutputTargets: config.AudioOutputTargets{Bridge: true, Visor: true},
		RealtimeIdleMS:     60_000,
		Version:            "test",
	}
}

func TestWriteJSONDoesNotExposeHTML(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeJSON(recorder, http.StatusOK, map[string]string{"value": "<safe>"})
	body, err := io.ReadAll(recorder.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "{\"value\":\"\\u003csafe\\u003e\"}\n" {
		t.Fatalf("unexpected JSON body: %s", body)
	}
}
