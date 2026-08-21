//go:build darwin && cgo

package audio

import (
	"errors"
	"sync"

	"github.com/gen2brain/malgo"
)

var ErrUnavailable = errors.New("native CoreAudio is unavailable")

type Capture struct {
	context *malgo.AllocatedContext
	device  *malgo.Device
	mu      sync.Mutex
	active  bool
	closed  bool
	onPCM   func([]byte)
}

func NewCapture(onPCM func([]byte)) (*Capture, error) {
	if onPCM == nil {
		return nil, errors.New("native capture callback is required")
	}
	context, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, err
	}
	config := malgo.DefaultDeviceConfig(malgo.Capture)
	config.SampleRate = 24_000
	config.PeriodSizeInMilliseconds = 20
	config.Capture.Format = malgo.FormatS16
	config.Capture.Channels = 1
	capture := &Capture{context: context, onPCM: onPCM}
	device, err := malgo.InitDevice(context.Context, config, malgo.DeviceCallbacks{
		Data: func(_ []byte, input []byte, _ uint32) {
			capture.mu.Lock()
			active := capture.active && !capture.closed
			callback := capture.onPCM
			capture.mu.Unlock()
			if active && callback != nil && len(input) > 0 {
				callback(append([]byte(nil), input...))
			}
		},
	})
	if err != nil {
		_ = context.Uninit()
		context.Free()
		return nil, err
	}
	capture.device = device
	return capture, nil
}

func (c *Capture) Start() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrUnavailable
	}
	c.active = true
	device := c.device
	c.mu.Unlock()
	if err := device.Start(); err != nil {
		c.mu.Lock()
		c.active = false
		c.mu.Unlock()
		return err
	}
	return nil
}

func (c *Capture) Stop() {
	c.mu.Lock()
	if !c.active {
		c.mu.Unlock()
		return
	}
	c.active = false
	device := c.device
	c.mu.Unlock()
	_ = device.Stop()
}

func (c *Capture) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	active, device, context := c.active, c.device, c.context
	c.active = false
	c.mu.Unlock()
	if active {
		_ = device.Stop()
	}
	device.Uninit()
	_ = context.Uninit()
	context.Free()
}

type Player struct {
	context *malgo.AllocatedContext
	device  *malgo.Device
	mu      sync.Mutex
	queue   []byte
	closed  bool
}

func NewPlayer() (*Player, error) {
	context, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, err
	}
	config := malgo.DefaultDeviceConfig(malgo.Playback)
	config.SampleRate = 24_000
	config.PeriodSizeInMilliseconds = 20
	config.Playback.Format = malgo.FormatS16
	config.Playback.Channels = 1
	player := &Player{context: context}
	device, err := malgo.InitDevice(context.Context, config, malgo.DeviceCallbacks{
		Data: func(output []byte, _ []byte, _ uint32) {
			player.mu.Lock()
			if len(output) > 0 {
				n := len(output)
				if n > len(player.queue) {
					n = len(player.queue)
				}
				copy(output[:n], player.queue[:n])
				player.queue = player.queue[n:]
				for i := n; i < len(output); i++ {
					output[i] = 0
				}
			}
			player.mu.Unlock()
		},
	})
	if err != nil {
		_ = context.Uninit()
		context.Free()
		return nil, err
	}
	player.device = device
	if err := device.Start(); err != nil {
		device.Uninit()
		_ = context.Uninit()
		context.Free()
		return nil, err
	}
	return player, nil
}

func (p *Player) Play(pcm []byte) error {
	if len(pcm) == 0 {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrUnavailable
	}
	const maxQueuedBytes = 24_000 * 2 * 2
	p.queue = append(p.queue, pcm...)
	if len(p.queue) > maxQueuedBytes {
		p.queue = append([]byte(nil), p.queue[len(p.queue)-maxQueuedBytes:]...)
	}
	return nil
}

func (p *Player) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	device, context := p.device, p.context
	p.queue = nil
	p.mu.Unlock()
	device.Uninit()
	_ = context.Uninit()
	context.Free()
}
