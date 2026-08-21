package media

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareResizesAndRedactsImageTitle(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "source.png")
	file, err := os.Create(input)
	if err != nil {
		t.Fatal(err)
	}
	source := image.NewRGBA(image.Rect(0, 0, 2_000, 1_000))
	for y := 0; y < source.Bounds().Dy(); y += 1 {
		for x := 0; x < source.Bounds().Dx(); x += 1 {
			source.SetRGBA(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 90, A: 255})
		}
	}
	if err := png.Encode(file, source); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	output := filepath.Join(root, "media")
	secretTitle := strings.Join([]string{"sk", "proj", "123456789012", "secret.png"}, "-")
	card, err := NewService([]string{root}, output).Prepare(input, secretTitle)
	if err != nil {
		t.Fatal(err)
	}
	if card.Width != 1_280 || card.Height != 640 || card.MimeType != "image/webp" || strings.Contains(card.Title, "sk-") {
		t.Fatalf("unexpected image card: %#v", card)
	}
	if _, err := os.Stat(filepath.Join(output, card.ID+".webp")); err != nil {
		t.Fatal(err)
	}
	if _, err := NewService([]string{root}, output).Prepare(filepath.Join(t.TempDir(), "outside.png"), "outside"); err == nil {
		t.Fatal("outside image should not be accepted")
	}
}

func TestSafeTitleTruncatesRunes(t *testing.T) {
	value := safeTitle(strings.Repeat("你", 200))
	if len([]rune(value)) != 160 {
		t.Fatalf("expected 160 runes, got %d", len([]rune(value)))
	}
}
