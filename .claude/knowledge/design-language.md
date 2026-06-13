# Design Language — Pulse ("Signal in the Dark")

_Last updated: 2026-06-13_

The single source of truth is `app/globals.css` (the `@theme` block, helper
classes, and keyframes). This file summarizes what is actually defined there and
how components consume it. The concept: a living radar of human presence —
deep dimensional dark, one luminous accent, motion that breathes.

> Earlier versions of this file described an emerald/zinc/Geist "Vercel-style"
> system (Emerald-400 `#10b981`, `text-base` buttons, `rounded-lg`). That system
> is gone. The real system is documented below.

## Color tokens (`@theme`)

All colors are CSS custom properties; Tailwind exposes them as `bg-*`, `text-*`,
`border-*` utilities (e.g. `bg-signal`, `text-haze-300`, `border-danger/25`).

- **Ink** — cool, dimensional near-black base (not flat zinc). `ink-950 #04060d`
  (body bg) through `ink-500 #2e3b60`. Scale: 950 / 900 / 850 / 800 / 750 / 700 / 600 / 500.
- **Haze** — text + hairlines on the dark base. `haze-50 #f1f4fc` (primary text)
  down to `haze-600 #445070`. Scale: 50 / 100 / 200 / 300 / 400 / 500 / 600.
  Body text is `haze-50`; secondary copy `haze-300`; micro-labels `haze-400/500`.
- **Signal** — the luminous mint-cyan accent, used sparingly with real glow.
  `signal #34f0bf` (the default), plus `signal-300 #7dfbd9` / `400 #4cf3c4` /
  `500 #25e9ad` / `600 #0fcf94`.
- **Aurora** — atmospheric secondaries for backdrops only (never UI chrome):
  `aurora-violet #7c5cff`, `aurora-blue #3f7bf6`, `aurora-teal #21d3d8`.
- **Danger** — `danger #ff4d62` (default), `danger-400 #ff6b7c`, `danger-600 #e23150`.

Per-peer hues live on map dots via the `--dot` custom property (set inline in
`WorldMap.tsx`), not in the token scale.

## Radius

`--radius-xs 0.375rem` · `sm 0.625rem` · `md 0.875rem` · `lg 1.25rem` ·
`xl 1.75rem` · `2xl 2.25rem`. Used as `rounded-md`, `rounded-2xl`, etc.
Pills (buttons, status chips, inputs) use `rounded-full`.

## Elevation / glow shadows

- `--shadow-glow-sm` / `--shadow-glow` / `--shadow-glow-lg` — signal-tinted glow
  via `color-mix`, exposed as `shadow-glow-sm`, `shadow-glow`, `shadow-glow-lg`.
  Used on the primary CTA, the "you are here" pin, sent chat bubbles, the send button.
- `--shadow-float` — deep neutral drop shadow for lifted glass surfaces
  (`shadow-float`).

## Blur / glass

Glass surfaces use `backdrop-filter: blur()` + `saturate()`. The reusable
helpers (below) encapsulate this; arbitrary `backdrop-blur` is used for small
chips.

## Fonts

- `--font-sans` → Geist Sans (`var(--font-geist-sans)`), the app default.
- `--font-mono` → Geist Mono (`var(--font-geist-mono)`), applied via `font-mono`.
  **Mono is the convention for all status text, HUD labels, eyebrows, and
  micro-labels** — typically uppercase with wide tracking (e.g.
  `font-mono text-[11px] uppercase tracking-wider`). Confirmed in EntryGate
  (eyebrow, privacy note), ChatPanel (connection status), VideoPanel (live
  badge, captions), SafetyPhrase (the phrase chip), WorldMap (HUD count).

## Signature easings

- `--ease-signal cubic-bezier(0.22, 1, 0.36, 1)` — swift settle (default enters).
- `--ease-spring cubic-bezier(0.34, 1.56, 0.64, 1)` — overshoot pop (presses,
  pills, scale-in). Applied to controls via `ease-[var(--ease-spring)]`.
- `--ease-calm cubic-bezier(0.65, 0, 0.35, 1)` — even both-ways (ambient loops:
  aurora, sonar, beacon, halo, twinkle).

## Motion

Two distinct mechanisms — keep them straight:

**`--animate-*` tokens → Tailwind `animate-*` utilities.** These are the only
named animation utilities available:
- `animate-fade-in` — opacity only.
- `animate-fade-up` — opacity + 14px rise (`ease-signal`). Content blocks, errors.
- `animate-scale-in` — opacity + scale 0.92 pop (`ease-spring`). PiP, cards.
- `animate-slide-in` — opacity + 40px slide from right (`ease-signal`). Drawers (ChatPanel).
- `animate-pill-in` — pill drop-in pop (`ease-spring`). Toasts/pills.
- `animate-msg-in` — opacity + 10px rise pop (`ease-spring`). Chat messages.
- `animate-spin-slow` — 1.1s linear infinite spin.

**Raw keyframes applied directly (not as `animate-*` utilities).** These are
referenced either inside globals.css rules or inline via `style={{ animation }}`:
- `sonar` — 1→3x expanding ring fade; drives `.pulse-dot::before` and `.pulse-me::after`.
- `beacon` — slow 0.6→2.6x expanding ring; EntryGate radar rings, VideoPanel (inline).
- `halo` — contained orb halo (stays ~1.8x); ConnectionPrompt (inline).
- `pulse-glow` — breathing glow behind the EntryGate wordmark (inline).
- `aurora` — drifting/rotating backdrop, drives `.aurora-field`.
- `twinkle` — opacity flicker, drives `.signal-grain`.

Tailwind's built-in `animate-ping` / `animate-pulse` are also used for live dots.

## Reusable helper classes

- `.glass` — primary glass surface: translucent `ink-850`, `blur(20px) saturate(1.4)`,
  a haze inner-hairline border, inner top highlight + `--shadow-float`. Used by
  ChatPanel drawer.
- `.glass-faint` — lighter glass (`blur(14px)`), no float shadow. VideoPanel HUD
  chips, captions, status badges.
- `.hairline` — sets a faint haze border-color (~11% opacity). Pair with a Tailwind
  `border` / `border-b` / `border-t`. Dividers, received chat bubbles, SafetyPhrase chip.
- `.text-glow` — signal-tinted text-shadow. The "Pulse" wordmark.
- `.aurora-field` — absolutely-positioned living backdrop (radial aurora gradients,
  blurred, `aurora` loop). EntryGate atmosphere.
- `.signal-grain` — faint twinkling star/signal grain overlay. EntryGate atmosphere.
- `.vignette` — radial darkening to seat the base and focus the center. EntryGate.

Map-marker hooks `.pulse-dot`, `.pulse-me`, `.pulse-me-label` are a fixed
class-hook contract with `WorldMap.tsx` — do not rename without updating both sides.

## Focus / accessibility

- **Focus ring (global):** `:where(button, a, input, [tabindex]):focus-visible`
  in globals.css replaces the outline with a two-layer `box-shadow` — a 2px
  `ink-950` gap then a 4px signal ring. Because it's a box-shadow, the ring
  follows each control's own radius (pills get pill-shaped rings).
- Text inputs additionally shift their border to `focus:border-signal/40` on focus.
- `color-scheme: dark` is set on `:root`; `::selection` uses a signal tint.

## Reduced motion (`prefers-reduced-motion: reduce`)

Handled entirely in globals.css — the experience stays "alive but not moving":
- All animations/transitions are clamped to `0.001ms` and iteration count `1`;
  `scroll-behavior: auto`.
- `.aurora-field` opacity is lowered to `0.45` (held, not animated).
- `.animate-ping` is hidden (`display: none`) so ripples don't freeze mid-fade.
- `.animate-pulse` is frozen at full opacity (`animation: none; opacity: 1`) so
  live-status dots read as steadily lit.

## Mapbox theming

Mapbox controls are art-directed in globals.css to match the dark glass HUD:
desaturated controls, glass attribution pill, dimmed logo. Lives at the bottom
of the file.
