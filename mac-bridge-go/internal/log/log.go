package log

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

type Level string

const (
	Debug Level = "debug"
	Info  Level = "info"
	Warn  Level = "warn"
	Error Level = "error"
)

type Logger struct {
	minimum Level
	mu      sync.Mutex
}

func New(minimum string) *Logger {
	level := Level(minimum)
	if level != Debug && level != Info && level != Warn && level != Error {
		level = Info
	}
	return &Logger{minimum: level}
}

func (l *Logger) Debug(message string, data map[string]any) { l.write(Debug, message, data) }
func (l *Logger) Info(message string, data map[string]any)  { l.write(Info, message, data) }
func (l *Logger) Warn(message string, data map[string]any)  { l.write(Warn, message, data) }
func (l *Logger) Error(message string, data map[string]any) { l.write(Error, message, data) }

func (l *Logger) write(level Level, message string, data map[string]any) {
	priority := map[Level]int{Debug: 10, Info: 20, Warn: 30, Error: 40}
	if priority[level] < priority[l.minimum] {
		return
	}
	record := map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "level": level, "message": message}
	if data != nil {
		record["data"] = data
	}
	line, _ := json.Marshal(record)
	l.mu.Lock()
	defer l.mu.Unlock()
	if level == Error || level == Warn {
		_, _ = os.Stderr.Write(append(line, '\n'))
		return
	}
	_, _ = os.Stdout.Write(append(line, '\n'))
}
