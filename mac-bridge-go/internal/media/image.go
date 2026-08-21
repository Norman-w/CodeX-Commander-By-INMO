package media

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	webp "github.com/HugoSmits86/nativewebp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/norman-w/codex-commander-go/internal/protocol"
	"github.com/norman-w/codex-commander-go/internal/security"
)

var secretPattern = regexp.MustCompile(`(?i)(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{16})`)

type Service struct {
	guard      *security.PathGuard
	outputRoot string
}

func NewService(roots []string, outputRoot string) *Service {
	return &Service{guard: security.NewPathGuard(roots), outputRoot: outputRoot}
}

func (s *Service) Prepare(input, title string) (protocol.ImageCard, error) {
	source, err := s.guard.ResolveAllowed(input)
	if err != nil {
		return protocol.ImageCard{}, err
	}
	stat, err := os.Stat(source)
	if err != nil {
		return protocol.ImageCard{}, err
	}
	idHash := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d", source, stat.Size(), stat.ModTime().UnixNano())))
	id := hex.EncodeToString(idHash[:])[:24]
	if err := os.MkdirAll(s.outputRoot, 0o700); err != nil {
		return protocol.ImageCard{}, err
	}
	in, err := os.Open(source)
	if err != nil {
		return protocol.ImageCard{}, err
	}
	defer in.Close()
	decoded, format, err := image.Decode(in)
	if err != nil {
		return protocol.ImageCard{}, fmt.Errorf("decode image (%s): %w", format, err)
	}
	if decoded.Bounds().Dx() > 40_000_000/maximum(1, decoded.Bounds().Dy()) {
		return protocol.ImageCard{}, fmt.Errorf("image is too large")
	}
	resized := fit(decoded, 1_280, 720)
	outputPath := filepath.Join(s.outputRoot, id+".webp")
	out, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return protocol.ImageCard{}, err
	}
	if err := webp.Encode(out, resized, nil); err != nil {
		_ = out.Close()
		_ = os.Remove(outputPath)
		return protocol.ImageCard{}, err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(outputPath)
		return protocol.ImageCard{}, err
	}
	return protocol.ImageCard{
		ID:       id,
		Title:    safeTitle(titleOrBase(title, source)),
		URL:      "/media/" + id + ".webp",
		Width:    resized.Bounds().Dx(),
		Height:   resized.Bounds().Dy(),
		MimeType: "image/webp",
	}, nil
}

func fit(source image.Image, maxWidth, maxHeight int) image.Image {
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= maxWidth && height <= maxHeight {
		return source
	}
	scale := math.Min(float64(maxWidth)/float64(width), float64(maxHeight)/float64(height))
	destination := image.NewRGBA(image.Rect(0, 0, maximum(1, int(float64(width)*scale)), maximum(1, int(float64(height)*scale))))
	draw.ApproxBiLinear.Scale(destination, destination.Bounds(), source, bounds, draw.Over, nil)
	return destination
}

func safeTitle(value string) string {
	value = filepath.Base(strings.ReplaceAll(value, "\\", "/"))
	value = secretPattern.ReplaceAllString(value, "[已隐藏密钥]")
	runes := []rune(value)
	if len(runes) > 160 {
		return string(runes[:160])
	}
	return value
}

func titleOrBase(title, source string) string {
	if strings.TrimSpace(title) != "" {
		return title
	}
	return filepath.Base(source)
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func maximum(left, right int) int {
	if left > right {
		return left
	}
	return right
}
