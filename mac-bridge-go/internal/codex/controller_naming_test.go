package codex

import (
	"testing"
	"time"
)

func TestFormatVoiceSessionName(t *testing.T) {
	got := formatVoiceSessionName(1, time.Date(2026, time.August, 21, 9, 30, 0, 0, time.Local))
	if got != "No.01 08-21" {
		t.Fatalf("formatVoiceSessionName() = %q, want %q", got, "No.01 08-21")
	}

	got = formatVoiceSessionName(12, time.Date(2026, time.December, 3, 9, 30, 0, 0, time.Local))
	if got != "No.12 12-03" {
		t.Fatalf("formatVoiceSessionName() = %q, want %q", got, "No.12 12-03")
	}
}

func TestParseVoiceSessionNumber(t *testing.T) {
	tests := []struct {
		name   string
		want   int
		wantOK bool
	}{
		{name: "No.01 08-21", want: 1, wantOK: true},
		{name: "No.12 12-03", want: 12, wantOK: true},
		{name: "No.01", wantOK: false},
		{name: "眼镜遥控 · 新任务", wantOK: false},
		{name: "No.00 08-21", wantOK: false},
	}

	for _, test := range tests {
		got, ok := parseVoiceSessionNumber(test.name)
		if got != test.want || ok != test.wantOK {
			t.Errorf("parseVoiceSessionNumber(%q) = (%d, %t), want (%d, %t)", test.name, got, ok, test.want, test.wantOK)
		}
	}
}
