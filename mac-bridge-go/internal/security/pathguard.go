package security

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

type PathGuard struct {
	roots []string
}

func NewPathGuard(roots []string) *PathGuard {
	return &PathGuard{roots: append([]string(nil), roots...)}
}

func (g *PathGuard) ResolveAllowed(input string) (string, error) {
	if !filepath.IsAbs(input) {
		return "", errors.New("media paths must be absolute")
	}
	resolved, err := filepath.EvalSymlinks(input)
	if err != nil {
		return "", err
	}
	for _, root := range g.roots {
		canonicalRoot, rootErr := filepath.EvalSymlinks(root)
		if rootErr != nil {
			continue
		}
		relative, relErr := filepath.Rel(canonicalRoot, resolved)
		if relErr != nil {
			continue
		}
		if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)) {
			return resolved, nil
		}
	}
	return "", fmt.Errorf("media path is outside COMMANDER_MEDIA_ROOTS: %s", resolved)
}
