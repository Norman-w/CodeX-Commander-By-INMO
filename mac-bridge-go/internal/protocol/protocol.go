package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

const (
	Version          = "visor.v1"
	AudioSampleRate  = 24_000
	AudioChannels    = 1
	AudioEncoding    = "pcm16le"
	ClientAudioFrame = byte(0x01)
	ServerAudioFrame = byte(0x02)
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var pairingPattern = regexp.MustCompile(`^[0-9]{6}$`)

type ClientControl struct {
	Type                 string `json:"type"`
	Protocol             string `json:"protocol"`
	RequestID            string `json:"requestId"`
	DeviceID             string `json:"deviceId"`
	DeviceName           string `json:"deviceName"`
	AppVersion           string `json:"appVersion"`
	Token                string `json:"token"`
	PairingCode          string `json:"pairingCode"`
	LastEventID          uint64 `json:"lastEventId"`
	SampleRate           int    `json:"sampleRate"`
	Channels             int    `json:"channels"`
	Encoding             string `json:"encoding"`
	ThreadID             string `json:"threadId"`
	Text                 string `json:"text"`
	ApprovalRequestID    string `json:"approvalRequestId"`
	Decision             string `json:"decision"`
	PhysicalConfirmation bool   `json:"physicalConfirmation"`
	Path                 string `json:"path"`
	Title                string `json:"title"`
	SentAt               int64  `json:"sentAt"`
	NewSession           bool   `json:"newSession"`
}

type ThreadSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Preview   string `json:"preview,omitempty"`
	Status    string `json:"status"`
	UpdatedAt int64  `json:"updatedAt,omitempty"`
}

type ApprovalCard struct {
	RequestID string `json:"requestId"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	ThreadID  string `json:"threadId"`
	TurnID    string `json:"turnId"`
	ExpiresAt int64  `json:"expiresAt"`
}

type ImageCard struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	MimeType string `json:"mimeType"`
}

type AudioLevel struct {
	RMS    float64 `json:"rms"`
	Peak   float64 `json:"peak"`
	Active bool    `json:"active"`
}

func ParseClientControl(raw []byte) (ClientControl, error) {
	var message ClientControl
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&message); err != nil {
		return message, errors.New("control frame is not valid JSON")
	}
	if message.Type == "" {
		return message, errors.New("control message type is required")
	}
	if !uuidPattern.MatchString(message.RequestID) {
		return message, errors.New("requestId must be a UUID")
	}
	if message.Type != "hello" && message.Type != "state_sync" && message.Type != "ptt_start" && message.Type != "ptt_end" && message.Type != "voice_target_select" && message.Type != "voice_target_new" && message.Type != "task_command" && message.Type != "task_interrupt" && message.Type != "approval_decision" && message.Type != "report_request" && message.Type != "image_request" && message.Type != "ping" {
		return message, fmt.Errorf("unsupported control message type: %s", message.Type)
	}
	switch message.Type {
	case "hello":
		if message.Protocol != Version {
			return message, fmt.Errorf("unsupported protocol: %s", message.Protocol)
		}
		if len(message.DeviceID) < 8 || len(message.DeviceID) > 160 || message.DeviceName == "" || len(message.DeviceName) > 120 || message.AppVersion == "" || len(message.AppVersion) > 40 {
			return message, errors.New("hello device metadata is invalid")
		}
		if (message.Token == "") == (message.PairingCode == "") {
			return message, errors.New("exactly one of token or pairingCode is required")
		}
		if message.PairingCode != "" && !pairingPattern.MatchString(message.PairingCode) {
			return message, errors.New("pairingCode must be six digits")
		}
		if message.Token != "" && (len(message.Token) < 16 || len(message.Token) > 512) {
			return message, errors.New("token is invalid")
		}
	case "ptt_start":
		if message.SampleRate != AudioSampleRate || message.Channels != AudioChannels || message.Encoding != AudioEncoding {
			return message, errors.New("ptt_start audio format is invalid")
		}
	case "ptt_end":
	case "state_sync":
	case "approval_decision":
		if message.ApprovalRequestID == "" || (message.Decision != "accept" && message.Decision != "decline" && message.Decision != "cancel") || !message.PhysicalConfirmation {
			return message, errors.New("approval decision requires physicalConfirmation=true")
		}
	case "task_command":
		if len(strings.TrimSpace(message.Text)) == 0 || len(message.Text) > 20_000 {
			return message, errors.New("task command text is invalid")
		}
	case "image_request":
		if message.Path == "" || len(message.Path) > 4_096 {
			return message, errors.New("image path is invalid")
		}
	case "ping":
		if message.SentAt < 0 {
			return message, errors.New("sentAt is invalid")
		}
	}
	return message, nil
}

func EncodeBinaryFrame(kind byte, payload []byte) []byte {
	frame := make([]byte, len(payload)+1)
	frame[0] = kind
	copy(frame[1:], payload)
	return frame
}

func DecodeBinaryFrame(frame []byte) (byte, []byte, error) {
	if len(frame) < 2 {
		return 0, nil, errors.New("binary frame must contain a kind byte and payload")
	}
	return frame[0], frame[1:], nil
}
