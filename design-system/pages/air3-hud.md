# AIR3 HUD Override

This page overrides the web-oriented master palette for the optical smart-glasses display.

- Background: pure black `#000000`; never draw a full-screen translucent layer.
- Primary text: `#F7FBFF`; status/accent: `#38D7FF`; muted text: `#A8B3BD`.
- Approval/destructive: `#FF5A67`; success: `#48E6A0`; warning: `#FFD166`.
- Use the Android system sans-serif only; do not download fonts on the glasses.
- Minimum body text: 18sp; primary status: 24sp; touch/configuration targets: 48dp.
- No shadows, blur, gradients, decorative animation, or continuous frame loop.
- Redraw only after state changes. Keep information inside the central safe area.
- Priority order: approval > requested image > completed report card > task progress.
- Every state must have a text label; color is never the only signal.
- Approval defaults to decline and requires a physical double-confirm action.

