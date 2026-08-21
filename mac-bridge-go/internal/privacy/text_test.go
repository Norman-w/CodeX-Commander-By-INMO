package privacy

import (
	"path/filepath"
	"testing"
)

func TestSanitizeForVisorRedactsSecretsPathsAndRunes(t *testing.T) {
	secret := "sk-" + "proj-" + "123456789012"
	privatePath := filepath.Join(string(filepath.Separator), "Users", "example", "private", "project")
	value := secret + " " + privatePath + " " + "你你你"
	result := SanitizeForVisor(value, 20, []string{privatePath})
	if result == value || containsAny(result, secret, privatePath) {
		t.Fatalf("sensitive value leaked: %q", result)
	}
	if len([]rune(result)) > 20 {
		t.Fatalf("result was not rune-truncated: %d", len([]rune(result)))
	}
}

func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		for index := 0; index+len(needle) <= len(value); index++ {
			if value[index:index+len(needle)] == needle {
				return true
			}
		}
	}
	return false
}
