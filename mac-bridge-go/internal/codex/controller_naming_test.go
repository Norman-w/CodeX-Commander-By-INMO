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

func TestCleanThreadPreview(t *testing.T) {
	got := cleanThreadPreview("<realtime_delegation>\n  <source>transcript_tail_flush</source>\n  <input>现在你那边的时间是几点?</input>\n  <transcript_delta>内部内容</transcript_delta>\n</realtime_delegation>", "")
	if got != "现在你那边的时间是几点?" {
		t.Fatalf("cleanThreadPreview() = %q, want clean user input", got)
	}

	if got := cleanThreadPreview("<realtime_delegation><source>transcript_tail_flush</source></realtime_delegation>", ""); got != "" {
		t.Fatalf("cleanThreadPreview() = %q, want empty internal preview", got)
	}
}

func TestNormalizeUnixMillis(t *testing.T) {
	if got := normalizeUnixMillis(1_787_276_340); got != 1_787_276_340_000 {
		t.Fatalf("normalizeUnixMillis(seconds) = %d, want milliseconds", got)
	}
	value := int64(1_787_276_340_000)
	if got := normalizeUnixMillis(value); got != value {
		t.Fatalf("normalizeUnixMillis(milliseconds) = %d, want unchanged", got)
	}
}
