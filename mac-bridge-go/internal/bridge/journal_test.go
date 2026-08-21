package bridge

import (
	"sync"
	"testing"
)

func TestEventJournalKeepsOnlyRememberedEvents(t *testing.T) {
	journal := NewEventJournal(2)
	first := journal.Create(map[string]any{"type": "first"}, true)
	_ = journal.Create(map[string]any{"type": "ephemeral"}, false)
	third := journal.Create(map[string]any{"type": "third"}, true)
	fourth := journal.Create(map[string]any{"type": "fourth"}, true)
	events := journal.After(0)
	if len(events) != 2 || events[0]["eventId"] != third["eventId"] || events[1]["eventId"] != fourth["eventId"] {
		t.Fatalf("unexpected journal: %#v", events)
	}
	if len(journal.After(first["eventId"].(uint64))) != 2 {
		t.Fatal("journal replay did not return events after checkpoint")
	}
}

func TestRequestDeduplicatorIsConcurrent(t *testing.T) {
	deduper := NewRequestDeduplicator(100)
	var wait sync.WaitGroup
	results := make(chan bool, 32)
	for i := 0; i < 32; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results <- deduper.IsDuplicate("same-request")
		}()
	}
	wait.Wait()
	close(results)
	seenNew := 0
	for duplicate := range results {
		if !duplicate {
			seenNew++
		}
	}
	if seenNew != 1 {
		t.Fatalf("expected one new request, got %d", seenNew)
	}
}
