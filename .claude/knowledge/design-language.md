# Design Language — Pulse Technical Assessment

_Last updated: 2026-06-14_

The system is **"Signal in the Dark"**: a deep, dimensional dark base, one luminous
mint-cyan accent used sparingly, and motion that breathes. Defined entirely in
`app/globals.css` via a Tailwind v4 `@theme` block (CSS-first config) plus helper
classes and raw keyframes. Components consume it through Tailwind utilities
(`bg-ink-850`, `text-haze-300`, `animate-fade-up`, `shadow-glow`) and a handful of
hand-written helper classes.

## Color tokens

All defined as `--color-*` in `@theme`, so each generates `bg-*`/`text-*`/`border-*`
utilities.

- **Ink** — cool, dimensional near-black base (not flat zinc):
  `ink-950 #04060d`, `900 #070b16`, `850 #0a0f1e`, `800 #0e1426`, `750 #121a30`,
  `700 #18213b`, `600 #222d4d`, `500 #2e3b60`. Body background is `ink-950`.
- **Haze** — text + hairlines on the dark base:
  `haze-50 #f1f4fc`, `100 #e1e7f5`, `200 #c0cae0`, `300 #9aa6c4`, `400 #7a87a8`,
  `500 #5b688a`, `600 #445070`. Body text is `haze-50`.
- **Signal** — the luminous mint-cyan accent, used sparingly:
  `signal-300 #7dfbd9`, `400 #4cf3c4`, `500 #25e9ad`, `600 #0fcf94`,
  and the base `signal #34f0bf`.
- **Aurora** — atmospheric secondaries, backdrops only:
  `aurora-violet #7c5cff`, `aurora-blue #3f7bf6`, `aurora-teal #21d3d8`.
- **Danger** — `danger-400 #ff6b7c`, `danger #ff4d62`, `danger-600 #e23150`.

`color-scheme: dark` is set on `:root`. Selection background is signal at 35% mix.

## Radius scale

`--radius-*`: `xs 0.375rem` (6px), `sm 0.625rem` (10px), `md 0.875rem` (14px),
`lg 1.25rem` (20px), `xl 1.75rem` (28px), `2xl 2.25rem` (36px). Cards/sheets
typically use `rounded-2xl`; pills and dots use `rounded-full` (9999px).

## Shadows — glow + elevation

- `shadow-glow-sm` / `shadow-glow` / `shadow-glow-lg` — signal-tinted glows at
  increasing spread (12px / 28px / 60px), built with `color-mix` of `--color-signal`.
- `shadow-float` — soft dark elevation: `0 24px 60px -20px rgba(0,0,0,.7)` +
  `0 8px 24px -12px rgba(0,0,0,.55)`. Used by `.glass`.

## Typography

- `--font-sans` = Geist Sans; `--font-mono` = Geist Mono.
- **Mono is the status/label voice**: connection state, counts, badges, kicker
  labels, codes. Always paired with `uppercase` + wide `tracking` (e.g.
  `tracking-[0.18em]`) at small sizes (10–11px). Sans is body/UI text.

## Signature easings

- `--ease-signal` `cubic-bezier(0.22,1,0.36,1)` — swift settle (default for entrances).
- `--ease-spring` `cubic-bezier(0.34,1.56,0.64,1)` — overshoot pop (scale/pill/msg).
- `--ease-calm` `cubic-bezier(0.65,0,0.35,1)` — even both-ways (ambient loops).

## Motion

### `--animate-*` utilities (generate `animate-*` classes via Tailwind)

These exist as theme tokens and are applied as classes:

- `fade-in` (0.5s, ease-signal) — overlays/scrims (`ConnectionPrompt`).
- `fade-up` (0.55s, ease-signal) — content entrances (`EntryGate`, empty states).
- `scale-in` (0.42s, ease-spring) — modal cards, picture-in-picture.
- `slide-in` (0.5s, ease-signal) — the chat sheet sliding from the right.
- `pill-in` (0.45s, ease-spring) — floating top/bottom status pills.
- `msg-in` (0.4s, ease-spring) — individual chat messages.
- `spin-slow` (1.1s linear infinite) — loading spinners.

### Raw `@keyframes` applied inline or via component CSS (no `animate-*` class)

- `sonar` — expanding ping ring (scale to 3x, fade out); drives the map peer dots
  (`.pulse-dot::before`) and the user pin (`.pulse-me::after`) in `WorldMap`.
- `beacon` — slow expanding ring (scale to 2.6x); applied inline in `EntryGate` and
  `VideoPanel` via `animation: "beacon …s var(--ease-calm) infinite"`.
- `halo` — contained pulse staying within a card (scale to 1.8x); applied inline in
  `ConnectionPrompt`.
- `pulse-glow` — a glow breathing in place; applied inline in `EntryGate`.
- `aurora` — drifting/rotating transform for the `.aurora-field` backdrop (22s loop).
- `twinkle` — opacity flicker for `.signal-grain` (7s loop).

Tailwind's built-in `animate-ping` and `animate-pulse` are also used for live status
dots (these are not project keyframes but are explicitly handled in reduced motion).

## Atmosphere helper classes

- `.glass` — translucent `ink-850` (72% mix) + `backdrop-filter: blur(20px) saturate(1.4)`
  + inner top hairline + `shadow-float`. The primary surface (chat sheet, modal, HUD).
- `.glass-faint` — lighter glass: `ink-850` 55% mix + `blur(14px)`, no float shadow.
  Used for floating pills and the small map count chips.
- `.hairline` — sets `border-color` to `haze-200` at 11% mix; pair with `border-*`
  utilities for dividers.
- `.text-glow` — signal-tinted `text-shadow`.
- `.aurora-field` — absolutely-positioned animated radial-gradient wash (violet/blue/
  signal/teal), blurred 36px, `opacity: 0.55`, running the `aurora` loop. Hero backdrop.
- `.signal-grain` — fine star/grain dot field, `opacity: 0.5`, running `twinkle`.
- `.vignette` — radial gradient that fades to `ink-950` at the edges to seat the base.

Map-marker classes (`.pulse-dot`, `.pulse-me`, `.pulse-me-label`) are a fixed
class-hook contract with `WorldMap.tsx`; the `--dot` custom property colors each peer.

## Focus

`:focus-visible` on `button, a, input, [tabindex]` removes the native outline and
applies a two-layer `box-shadow` ring: a 2px `ink-950` inset gap then a 4px signal
ring (80% mix). Because it's a box-shadow, the ring follows each control's own radius
(pills get pill-shaped rings). Scrollbars are slim, `ink-600` thumb on transparent.

## Reduced motion — IS implemented

`@media (prefers-reduced-motion: reduce)` does the following:

- Clamps `animation-duration` and `transition-duration` to `0.001ms`, forces
  `animation-iteration-count: 1`, and disables smooth scroll — globally on
  `*, *::before, *::after`.
- `.aurora-field` opacity drops to `0.45` (still present, just not drifting).
- `.animate-ping` is `display: none` (the expanding ripples would otherwise freeze
  mid-fade).
- `.animate-pulse` is frozen: `animation: none` and `opacity: 1` (live status dots
  hold at a steady, fully-visible glow).

Intent: the interface stays alive and legible, it just stops moving.

## Mapbox theming

Mapbox controls are art-directed to match the dark glass HUD: attribution desaturated,
compact attrib pill given `ink-850` glass background + blur + full radius, logo at 0.45
opacity, control text in `haze-500`.

---

Source of truth: `app/globals.css`. Concept narrative: `phase-2-design-brief.md`
(the brief approximates hex/animation values — globals.css is authoritative).
