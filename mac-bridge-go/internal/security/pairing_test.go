package security

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPairingStorePersistsAndRotates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", "pairing.json")
	store := NewPairingStore(path)
	first, err := store.Initialize()
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Code) != 6 || first.PairedDeviceID != "" || first.ExpiresAt <= 0 {
		t.Fatalf("unexpected initial pairing snapshot: %#v", first)
	}
	if token, err := store.Pair("air3-device", "000000"); err != nil || token != "" {
		t.Fatalf("wrong code should not pair: token=%q err=%v", token, err)
	}
	token, err := store.Pair("air3-device", first.Code)
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 40 || !store.IsTokenValid("air3-device", token) || store.IsTokenValid("other-device", token) {
		t.Fatal("pairing token validation failed")
	}

	reloaded := NewPairingStore(path)
	snapshot, err := reloaded.Initialize()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.PairedDeviceID != "air3-device" || snapshot.Code != "already paired" || !reloaded.IsTokenValid("air3-device", token) {
		t.Fatalf("pairing state did not persist: %#v", snapshot)
	}

	rotated, err := reloaded.Reset()
	if err != nil {
		t.Fatal(err)
	}
	if rotated.PairedDeviceID != "" || len(rotated.Code) != 6 || reloaded.IsTokenValid("air3-device", token) {
		t.Fatalf("pairing reset failed: %#v", rotated)
	}
}

func TestPairingStoreRejectsCorruptState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pairing.json")
	if err := os.WriteFile(path, []byte("not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewPairingStore(path).Initialize(); err == nil {
		t.Fatal("expected corrupt pairing state to fail closed")
	}
}

func TestPathGuardAllowsDotNamesAndRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "...")
	if err := os.WriteFile(inside, []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewPathGuard([]string{root}).ResolveAllowed(inside); err != nil {
		t.Fatalf("dot filename should be allowed: %v", err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("no"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewPathGuard([]string{root}).ResolveAllowed(outside); err == nil {
		t.Fatal("outside path should be rejected")
	}
}
