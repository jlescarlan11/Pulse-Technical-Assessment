# Pulse — Phase 2 Design Brief ("Signal in the Dark")

Phase 2 is pure UI/UX. The functionality is done and must not regress. Goal:
make Pulse genuinely beautiful — something you'd be proud to show off.

## Creative concept: Signal in the Dark
Pulse is a living radar of human presence. The whole experience is "tuning into
strangers broadcasting from the dark." Every visual choice should reinforce:
- **Life / heartbeat** — things breathe, pulse, and glow. Nothing is static.
- **Signal / radar / sonar** — rings, sweeps, ripples, luminous dots.
- **Depth & atmosphere** — a deep, dimensional dark, not flat zinc. Vignettes,
  glows, soft grain, layered translucency (real glassmorphism).
- **Calm confidence** — generous space, refined type, restrained accent use so
  the glow actually reads as special.

## Design system (the foundation — build first)
- **Color:** move off flat `zinc`. A near-black ink base with subtle blue/violet
  depth. One signature luminous accent (refined emerald → "signal green",
  ~`#34f5c5`/aurora-mint family) used sparingly with real glow. A destructive red.
  Per-peer hues stay (identity) but get a controlled saturation/lightness band so
  the map feels cohesive, not confetti.
- **Type:** actually use Geist (kill the Arial fallback). Tight, confident display
  sizes for headings; comfortable body; Geist Mono for system/HUD micro-labels.
- **Tokens in `app/globals.css` `@theme`:** color scale, radii, elevation/shadow
  scale, blur, and a motion vocabulary (durations + signature easings, e.g. a
  soft spring-like `cubic-bezier`).
- **Motion:** orchestrated, tasteful. Enter/exit transitions for every overlay,
  micro-interactions on every control, ambient ambient life on idle surfaces.
  Respect `prefers-reduced-motion`.

## Surface-by-surface intent
1. **EntryGate (first impression — set the bar):** atmospheric living backdrop
   (sonar sweep / aurora / drifting signal field), big confident wordmark, a
   glowing primary CTA with a satisfying press, graceful locating + error states.
2. **WorldMap (the hero):** luminous breathing peer dots with signal rings, a
   refined "you are here" pin, an elegant glass HUD (brand mark + live count that
   feels alive). Connection-state feedback that reads as a transmission.
3. **ConnectionPrompt (modal):** beautiful glass card, spring enter/exit, a sense
   of "an incoming signal" (avatar/identity hint from the peer's color).
4. **ChatPanel (drawer):** glass side panel, animated message entry, warm empty
   state, polished composer, clear connected/connecting affordance.
5. **VideoPanel:** cinematic full-bleed remote, smooth floating local PiP,
   refined controls that auto-calm.
6. **Toasts/notices:** refined glass pills with enter/exit motion.

## Guardrails
- Do NOT change WebRTC/signaling/state-machine logic in `app/page.tsx`. UI only.
- Keep all existing class hooks the map relies on (`.pulse-dot`, `.pulse-me`,
  `.pulse-me-label`) working, or update both sides together.
- Keep accessibility: focus states, contrast, reduced-motion, keyboard paths.
- Must build clean (`npm run build`) and keep existing tests green.
