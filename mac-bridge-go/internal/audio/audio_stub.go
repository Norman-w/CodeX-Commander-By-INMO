//go:build !darwin || !cgo

package audio

import "errors"

var ErrUnavailable = errors.New("native CoreAudio is unavailable in this build")

type Capture struct{}

func NewCapture(func([]byte)) (*Capture, error) { return nil, ErrUnavailable }
func (c *Capture) Start() error                 { return ErrUnavailable }
func (c *Capture) Close()                       {}

type Player struct{}

func NewPlayer() (*Player, error)   { return nil, ErrUnavailable }
func (p *Player) Play([]byte) error { return ErrUnavailable }
func (p *Player) Close()            {}
