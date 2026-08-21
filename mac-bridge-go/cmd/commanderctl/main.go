package main

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"encoding/xml"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "bind-current-codex":
		err = bindCurrentCodex(os.Args[2:])
	case "pairing-code":
		err = pairingCode(os.Args[2:])
	case "tailscale-dns":
		err = tailscaleDNS()
	case "launch-agent":
		err = launchAgent(os.Args[2:])
	case "help", "-h", "--help":
		usage()
		return
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: commanderctl <bind-current-codex|pairing-code|tailscale-dns|launch-agent>")
}

func bindCurrentCodex(args []string) error {
	flags := flag.NewFlagSet("bind-current-codex", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	envPath := flags.String("env", ".env", "path to the environment file")
	threadID := flags.String("thread-id", os.Getenv("CODEX_THREAD_ID"), "Codex thread UUID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !isUUID(*threadID) {
		return errors.New("当前终端没有可用的 CODEX_THREAD_ID；请从要遥控的 Codex 任务内运行本脚本")
	}
	data, err := os.ReadFile(*envPath)
	if err != nil {
		return fmt.Errorf("读取 %s 失败: %w", *envPath, err)
	}
	bindingID, err := newUUID()
	if err != nil {
		return err
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	foundThread, foundBinding := false, false
	for index, line := range lines {
		switch {
		case strings.HasPrefix(line, "COMMANDER_THREAD_ID="):
			lines[index] = "COMMANDER_THREAD_ID=" + *threadID
			foundThread = true
		case strings.HasPrefix(line, "COMMANDER_CONTEXT_BINDING_ID="):
			lines[index] = "COMMANDER_CONTEXT_BINDING_ID=" + bindingID
			foundBinding = true
		}
	}
	if !foundThread {
		lines = append(lines, "COMMANDER_THREAD_ID="+*threadID)
	}
	if !foundBinding {
		lines = append(lines, "COMMANDER_CONTEXT_BINDING_ID="+bindingID)
	}
	content := strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n"
	if err := atomicWrite(*envPath, []byte(content), 0o600); err != nil {
		return fmt.Errorf("写入 %s 失败: %w", *envPath, err)
	}
	return os.Chmod(*envPath, 0o600)
}

func pairingCode(args []string) error {
	flags := flag.NewFlagSet("pairing-code", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	logPath := flags.String("log", "", "bridge JSON log path")
	sinceMillis := flags.Int64("since", time.Now().Add(-15*time.Second).UnixMilli(), "only accept reset events after this Unix millisecond")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *logPath == "" {
		return errors.New("pairing-code requires --log")
	}
	file, err := os.Open(*logPath)
	if err != nil {
		return err
	}
	defer file.Close()
	var found string
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 32*1024), 1<<20)
	for scanner.Scan() {
		var record struct {
			Time    string `json:"time"`
			Message string `json:"message"`
			Data    struct {
				PairingCode string `json:"pairingCode"`
			} `json:"data"`
		}
		if json.Unmarshal(scanner.Bytes(), &record) != nil || record.Message != "Pairing reset" || record.Data.PairingCode == "" {
			continue
		}
		at, parseErr := time.Parse(time.RFC3339Nano, record.Time)
		if parseErr == nil && at.UnixMilli() >= *sinceMillis {
			found = record.Data.PairingCode
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if found == "" {
		return errors.New("未能从本机私有日志读取新配对码")
	}
	fmt.Println(found)
	return nil
}

func tailscaleDNS() error {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	var status struct {
		Self struct {
			DNSName string `json:"DNSName"`
		} `json:"Self"`
	}
	if err := json.Unmarshal(data, &status); err != nil {
		return fmt.Errorf("解析 Tailscale 状态失败: %w", err)
	}
	name := strings.TrimSuffix(strings.TrimSpace(status.Self.DNSName), ".")
	if name == "" {
		return errors.New("Tailscale 状态没有 Self.DNSName")
	}
	fmt.Println(name)
	return nil
}

func launchAgent(args []string) error {
	flags := flag.NewFlagSet("launch-agent", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	output := flags.String("output", "", "output plist path")
	label := flags.String("label", "", "launchd label")
	root := flags.String("root", "", "project root")
	binary := flags.String("binary", "", "bridge binary")
	stdout := flags.String("stdout", "", "stdout log path")
	stderr := flags.String("stderr", "", "stderr log path")
	pathValue := flags.String("path", os.Getenv("PATH"), "launchd PATH")
	if err := flags.Parse(args); err != nil {
		return err
	}
	for name, value := range map[string]string{"output": *output, "label": *label, "root": *root, "binary": *binary, "stdout": *stdout, "stderr": *stderr} {
		if value == "" {
			return fmt.Errorf("launch-agent requires --%s", name)
		}
	}
	program := filepath.Join(*root, "scripts", "with-local-env.sh")
	xmlContent := launchAgentXML(*label, program, *binary, *root, *stdout, *stderr, *pathValue)
	return atomicWrite(*output, []byte(xmlContent), 0o600)
}

func launchAgentXML(label, program, binary, root, stdout, stderr, pathValue string) string {
	stringElement := func(value string) string {
		return "<string>" + xmlEscape(value) + "</string>"
	}
	return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
		"<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n" +
		"<plist version=\"1.0\"><dict>\n" +
		"  <key>Label</key>" + stringElement(label) + "\n" +
		"  <key>ProgramArguments</key><array>" + stringElement(program) + stringElement(binary) + "</array>\n" +
		"  <key>WorkingDirectory</key>" + stringElement(root) + "\n" +
		"  <key>EnvironmentVariables</key><dict><key>PATH</key>" + stringElement(pathValue) + "</dict>\n" +
		"  <key>RunAtLoad</key><true/>\n" +
		"  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n" +
		"  <key>ThrottleInterval</key><integer>5</integer>\n" +
		"  <key>StandardOutPath</key>" + stringElement(stdout) + "\n" +
		"  <key>StandardErrorPath</key>" + stringElement(stderr) + "\n" +
		"</dict></plist>\n"
}

func xmlEscape(value string) string {
	var builder strings.Builder
	_ = xml.EscapeText(&builder, []byte(value))
	return builder.String()
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".commanderctl-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, path)
}

func newUUID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	data[6] = (data[6] & 0x0f) | 0x40
	data[8] = (data[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", data[0:4], data[4:6], data[6:8], data[8:10], data[10:16]), nil
}

func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
			continue
		}
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}
