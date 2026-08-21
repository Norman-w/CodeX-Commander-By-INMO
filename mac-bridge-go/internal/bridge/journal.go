package bridge

import (
	"sync"
	"time"
)

type EventJournal struct {
	mu       sync.RWMutex
	nextID   uint64
	capacity int
	events   []map[string]any
}

func NewEventJournal(capacity int) *EventJournal {
	if capacity <= 0 {
		capacity = 300
	}
	return &EventJournal{capacity: capacity, nextID: 1}
}

func (j *EventJournal) Create(payload map[string]any, remember bool) map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	event := make(map[string]any, len(payload)+3)
	for key, value := range payload {
		event[key] = value
	}
	event["protocol"] = "visor.v1"
	event["eventId"] = j.nextID
	event["sentAt"] = time.Now().UnixMilli()
	j.nextID++
	if remember {
		j.events = append(j.events, cloneMap(event))
		if len(j.events) > j.capacity {
			j.events = append([]map[string]any(nil), j.events[len(j.events)-j.capacity:]...)
		}
	}
	return event
}

func (j *EventJournal) After(lastID uint64) []map[string]any {
	j.mu.RLock()
	defer j.mu.RUnlock()
	result := make([]map[string]any, 0)
	for _, event := range j.events {
		if id, ok := event["eventId"].(uint64); ok && id > lastID {
			result = append(result, cloneMap(event))
			continue
		}
		if id, ok := event["eventId"].(int); ok && uint64(id) > lastID {
			result = append(result, cloneMap(event))
		}
	}
	return result
}

type RequestDeduplicator struct {
	mu       sync.Mutex
	capacity int
	seen     map[string]time.Time
}

func NewRequestDeduplicator(capacity int) *RequestDeduplicator {
	if capacity <= 0 {
		capacity = 1_000
	}
	return &RequestDeduplicator{capacity: capacity, seen: make(map[string]time.Time)}
}

func (d *RequestDeduplicator) IsDuplicate(requestID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[requestID]; ok {
		return true
	}
	d.seen[requestID] = time.Now()
	if len(d.seen) > d.capacity {
		var oldest string
		var oldestAt time.Time
		for id, at := range d.seen {
			if oldest == "" || at.Before(oldestAt) {
				oldest, oldestAt = id, at
			}
		}
		delete(d.seen, oldest)
	}
	return false
}

func cloneMap(input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
