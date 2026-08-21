package security

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const pairingTTL = 10 * time.Minute

type PairingSnapshot struct {
	Code           string `json:"code"`
	ExpiresAt      int64  `json:"expiresAt"`
	PairedDeviceID string `json:"pairedDeviceId,omitempty"`
}

type persistedPairingState struct {
	Version            int    `json:"version"`
	PairingCodeHash    string `json:"pairingCodeHash"`
	PairingCodeExpires int64  `json:"pairingCodeExpiresAt"`
	DeviceID           string `json:"deviceId,omitempty"`
	DeviceTokenHash    string `json:"deviceTokenHash,omitempty"`
}

type PairingStore struct {
	path           string
	mu             sync.RWMutex
	state          persistedPairingState
	plainCode      string
	failedAttempts int
}

func NewPairingStore(path string) *PairingStore {
	return &PairingStore{path: path}
}

func (p *PairingStore) Initialize() (PairingSnapshot, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	data, err := os.ReadFile(p.path)
	if err == nil {
		if err := json.Unmarshal(data, &p.state); err != nil {
			return PairingSnapshot{}, fmt.Errorf("invalid pairing state: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return PairingSnapshot{}, err
	}
	if p.state.DeviceID == "" || p.state.DeviceTokenHash == "" {
		if err := p.rotateLocked(); err != nil {
			return PairingSnapshot{}, err
		}
	}
	return p.snapshotLocked(), nil
}

func (p *PairingStore) Snapshot() PairingSnapshot {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.snapshotLocked()
}

func (p *PairingStore) IsTokenValid(deviceID, token string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if deviceID == "" || token == "" || p.state.DeviceID != deviceID || p.state.DeviceTokenHash == "" {
		return false
	}
	return constantTimeStringEqual(p.state.DeviceTokenHash, hash(token))
}

func (p *PairingStore) Pair(deviceID, code string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state.DeviceID != "" && p.state.DeviceTokenHash != "" {
		return "", nil
	}
	if time.Now().UnixMilli() >= p.state.PairingCodeExpires {
		return "", nil
	}
	if !constantTimeStringEqual(p.state.PairingCodeHash, hash(code)) {
		p.failedAttempts++
		if p.failedAttempts >= 10 {
			if err := p.rotateLocked(); err != nil {
				return "", err
			}
		}
		return "", nil
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	p.failedAttempts = 0
	p.state.DeviceID = deviceID
	p.state.DeviceTokenHash = hash(token)
	p.state.PairingCodeExpires = 0
	p.state.PairingCodeHash = hash(randomHex(16))
	p.plainCode = ""
	if err := p.persistLocked(); err != nil {
		return "", err
	}
	return token, nil
}

func (p *PairingStore) Reset() (PairingSnapshot, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.rotateLocked(); err != nil {
		return PairingSnapshot{}, err
	}
	return p.snapshotLocked(), nil
}

func (p *PairingStore) snapshotLocked() PairingSnapshot {
	code := p.plainCode
	if code == "" {
		code = "already paired"
	}
	return PairingSnapshot{Code: code, ExpiresAt: p.state.PairingCodeExpires, PairedDeviceID: p.state.DeviceID}
}

func (p *PairingStore) rotateLocked() error {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return err
	}
	p.plainCode = fmt.Sprintf("%06d", n.Int64())
	p.failedAttempts = 0
	p.state = persistedPairingState{
		Version:            1,
		PairingCodeHash:    hash(p.plainCode),
		PairingCodeExpires: time.Now().Add(pairingTTL).UnixMilli(),
	}
	return p.persistLocked()
}

func (p *PairingStore) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d", p.path, os.Getpid())
	data, err := json.MarshalIndent(p.state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.path)
}

func hash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func randomHex(size int) string {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "pairing-rotation"
	}
	return hex.EncodeToString(data)
}

func constantTimeStringEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
