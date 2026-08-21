package main

import (
	"context"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/norman-w/codex-commander-go/internal/bridge"
	"github.com/norman-w/codex-commander-go/internal/config"
	"github.com/norman-w/codex-commander-go/internal/log"
	"github.com/norman-w/codex-commander-go/internal/server"
)

func main() {
	workingDir, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	if filepath.Base(workingDir) == "mac-bridge-go" {
		_ = config.LoadDotEnv(filepath.Join(workingDir, "../.env"))
		_ = config.LoadDotEnv(filepath.Join(workingDir, ".env"))
	} else {
		_ = config.LoadDotEnv(filepath.Join(workingDir, ".env"))
		_ = config.LoadDotEnv(filepath.Join(workingDir, "mac-bridge-go", ".env"))
	}
	// Match the Node package's repo-root default when launched from this folder.
	if os.Getenv("COMMANDER_CWD") == "" && filepath.Base(workingDir) == "mac-bridge-go" {
		_ = os.Setenv("COMMANDER_CWD", filepath.Dir(workingDir))
	}

	c, err := config.Load()
	if err != nil {
		panic(err)
	}
	logger := log.New(c.LogLevel)
	b := bridge.New(c, logger)
	s := server.New(c, b, logger)

	pairing, startupErr := b.Start(context.Background())
	if startupErr != nil {
		logger.Error("Bridge startup failed; management page will remain available", map[string]any{"error": startupErr.Error()})
	}
	logger.Info("CodeX Commander Go Bridge ready", map[string]any{
		"listen":           "http://" + c.Host + ":" + itoa(c.Port),
		"websocket":        "ws://" + c.Host + ":" + itoa(c.Port) + "/v1/visor",
		"cwd":              c.CWD,
		"appServerMode":    c.AppServerMode,
		"pairingCode":      pairing.Code,
		"pairingExpiresAt": pairing.ExpiresAt,
		"startupError":     errorText(startupErr),
	})

	listenErr := make(chan error, 1)
	go func() { listenErr <- s.Listen() }()

	signalContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	running := true
	for running {
		select {
		case err := <-listenErr:
			if err != nil {
				logger.Error("Bridge HTTP server stopped unexpectedly", map[string]any{"error": err.Error()})
			}
			running = false
		case <-hup:
			pairing, resetErr := b.ResetPairing()
			if resetErr != nil {
				logger.Error("Pairing reset failed", map[string]any{"error": resetErr.Error()})
				continue
			}
			logger.Info("Pairing reset", map[string]any{
				"pairingCode":    pairing.Code,
				"expiresAt":      pairing.ExpiresAt,
				"pairedDeviceId": pairing.PairedDeviceID,
			})
		case <-signalContext.Done():
			logger.Info("Stopping bridge", map[string]any{"signal": signalContext.Err().Error()})
			running = false
		}
	}

	shutdownContext, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_ = s.Close(shutdownContext)
	_ = b.Stop(shutdownContext)
}

func itoa(value int) string {
	if value < 0 {
		return "0"
	}
	const digits = "0123456789"
	if value == 0 {
		return "0"
	}
	var reversed [20]byte
	index := len(reversed)
	for value > 0 {
		index--
		reversed[index] = digits[value%10]
		value /= 10
	}
	return string(reversed[index:])
}

func errorText(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}
