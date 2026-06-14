"use client";

import { useState, useSyncExternalStore } from "react";
import type { PeerDot } from "@/lib/types";
import { POLL_INTERVAL_MS } from "@/lib/presence";
import {
  nearestPeer,
  reduceTrend,
  NEUTRAL_STATE,
  type Trend,
  type TrendState,
} from "@/lib/proximity";

// Phase 4 "Proximity Pulse" — an AMBIENT signal that intensifies as the single
// nearest anonymous peer trends closer over the session. It is deliberately
// vague: no number, no bearing, no coordinate, no peer identity, and no line or
// highlight tying it to a specific map dot (a stakeholder CUT). The copy carries
// the honesty — it conveys a TREND with uncertainty, never a measurement.

// Minimum spacing between live-region announcements, expressed as a count of
// poll samples (a new `peers` array arrives roughly every POLL_INTERVAL_MS). We
// debounce in SAMPLES rather than wall-clock milliseconds for two reasons: it
// keeps the trend logic pure (no Date.now() during render — the poll cadence IS
// our clock), and samples are the real granularity at which we can ever change.
// Default ~8s of calm: without it, a flapping trend could announce on nearly
// every poll and overwhelm a screen-reader user. We also never re-announce the
// same state. (Math.ceil so we round UP to whole samples.)
const ANNOUNCE_MIN_SAMPLES = Math.ceil(8_000 / POLL_INTERVAL_MS); // ~6 samples

// Honest, measurement-free copy per trend. NEVER contains a number or a bearing
// (asserted by tests): each line conveys direction + uncertainty only.
const TREND_COPY: Record<Trend, string> = {
  stronger: "A signal is growing stronger",
  fainter: "A signal is fading",
  steady: "A signal is holding steady",
  neutral: "Listening for a signal",
};

// Live reduced-motion preference, read via useSyncExternalStore so it stays in
// sync without a setState-in-effect. WHY this matters here (not just CSS): this
// component drives a continuous breathing glow from JS; under reduced motion we
// must NOT run that loop and instead convey intensity with a single stable
// opacity STEP. The project precedent is to branch on matchMedia MANUALLY for
// JS-driven motion (see WorldMap.tsx prefersReducedMotion()). SSR snapshot is
// `false` so server + first client paint agree (no hydration mismatch).
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function getReducedMotionSnapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

// The announcement bookkeeping carried across samples. Kept in state (not a ref)
// so it updates via the React-recommended "adjust state during render" pattern
// below — no effect, no ref-during-render, no clock read.
interface AnnounceState {
  /** The phrase currently in the live region (""=silent). */
  text: string;
  /** Last trend we announced (or reset to), to dedupe repeat announcements. */
  lastTrend: Trend;
  /** Samples processed since the last spoken announcement (the debounce). */
  sinceAnnounce: number;
}

const INITIAL_ANNOUNCE: AnnounceState = {
  text: "",
  lastTrend: "neutral",
  sinceAnnounce: ANNOUNCE_MIN_SAMPLES, // start "ready to speak"
};

export default function ProximityPulse({
  peers,
  me,
  hidden = false,
}: {
  peers: PeerDot[];
  me: { lat: number; lng: number } | null;
  // S3 — while a chat panel is up the page keeps this component MOUNTED and
  // passes hidden=true (instead of unmounting it). We then fade the orb out and
  // go SILENT, but preserve the internal trend state so it survives the chat and
  // is warm on return — no pop, no lost build-up.
  hidden?: boolean;
}) {
  const reduceMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    () => false, // server snapshot — assume motion-on so SSR matches first paint
  );

  // Smoothed trend state (drives the visual) + the announcement bookkeeping.
  const [state, setState] = useState<TrendState>(NEUTRAL_STATE);
  const [announce, setAnnounce] = useState<AnnounceState>(INITIAL_ANNOUNCE);

  // SAMPLING via the React-recommended "adjust state when a prop changes during
  // render" pattern: we remember the exact `peers`/`me` references we last
  // processed and, when EITHER changes, run the pure reducer once — synchronously
  // in render, NOT in an effect (so no cascading-render / set-state-in-effect
  // smell, and no second faster-than-the-poll timer). React re-renders
  // immediately with the new state; nothing flickers. We can't learn the nearest
  // peer's distance any more often than the poll delivers a new `peers` array,
  // so a static peer naturally produces a STEADY indicator, never a climbing one.
  const [seenPeers, setSeenPeers] = useState<PeerDot[] | null>(null);
  const [seenMe, setSeenMe] = useState<typeof me>(null);
  if (peers !== seenPeers || me !== seenMe) {
    setSeenPeers(peers);
    setSeenMe(me);

    const sample = nearestPeer(peers, me);
    const next = reduceTrend(state, sample);
    setState(next);

    // Announcement debounce + dedupe, derived in the same pass. We speak only on
    // a genuine TREND change and NEVER on a nearest-swap RESET: reduceTrend
    // returns trend:"neutral" both for a swap and for the absent state — neither
    // is a real "stronger/fainter" event — so suppressing "neutral" covers both
    // "no phantom announcement on a swap" and "don't spam the live region when
    // absent" in one rule. The debounce counts SAMPLES (the poll cadence is our
    // clock) so this stays pure — no Date.now() during render.
    const trend = next.trend;
    const counted = Math.min(announce.sinceAnnounce + 1, ANNOUNCE_MIN_SAMPLES);
    if (trend === announce.lastTrend) {
      // Same state: stay quiet, but keep accruing toward the next debounce gate.
      setAnnounce({ ...announce, sinceAnnounce: counted });
    } else if (trend === "neutral") {
      // Absent / reset: go silent (clear the phrase) without re-announcing.
      setAnnounce({ text: "", lastTrend: "neutral", sinceAnnounce: counted });
    } else if (counted >= ANNOUNCE_MIN_SAMPLES) {
      // A real trend change, and enough samples have passed → announce, reset gate.
      setAnnounce({ text: TREND_COPY[trend], lastTrend: trend, sinceAnnounce: 0 });
    } else {
      // Real change but still within the debounce window → hold, keep counting.
      setAnnounce({ ...announce, sinceAnnounce: counted });
    }
  }

  const present = state.trend !== "neutral";
  // Clamp the glow's resting visibility to a calm floor so it never fully
  // vanishes while a signal is present; `level` (0..1) warms it toward 1.
  const intensity = present ? 0.35 + state.level * 0.65 : 0;

  // S3 — while hidden (a chat panel is up) the orb fades out, the visible label
  // hides, and the live region goes SILENT. We keep computing trend above (cheap)
  // so the state stays warm for the return, but we suppress BOTH visible and
  // announced output here. The orb is shown only when a signal is present AND we
  // are not hidden; the announced text is blanked while hidden so a screen reader
  // never hears trend chatter for an off-screen, behind-the-panel widget.
  const showOrb = present && !hidden;
  // The visible micro-label (S2) shows the SAME honest trend phrase as the live
  // region — trend only, no number/bearing/identity — but only for an ACTIVE
  // signal (never the neutral "Listening…" copy, which would be persistent
  // clutter). Hidden while in chat.
  const showLabel = present && !hidden;
  const announced = hidden ? "" : announce.text;

  return (
    // HUD SLOT: lower-right edge (bottom-24 right-4). S1 — moved OFF the vertical
    // center: the map-controls cluster lives at right-4 top-4 and descends ~210px
    // (four h-11 buttons + dividers), so on a SHORT/landscape viewport (e.g.
    // 667×375) a center-right orb collided with the controls' bottom. Anchoring to
    // bottom-24 puts the orb in the right gutter BELOW the controls on every
    // viewport while clearing the other occupied zones: brand mark (top-left),
    // coach hint (top-center), presence chip + nearby list (bottom-left), the
    // video-requesting pill (bottom-center, left-1/2 — horizontally clear of the
    // right gutter), and the Mapbox attribution (bottom-right, a ~22px strip that
    // bottom-24's 96px offset clears). Verified collision-free at BOTH 375×667
    // portrait and 667×375 landscape. z-30 keeps it BELOW the z-40 prompts/panels
    // and z-50 toasts: it's ambient UI and must never occlude an actionable
    // surface. pointer-events-none — purely informational, never a tap target.
    // NOTE: aria-hidden is NOT on this wrapper (B1) — that would prune the live
    // region from the a11y tree and silence every announcement. aria-hidden sits
    // only on the decorative orb + the redundant visible label below; the
    // role=status region is a NON-hidden sibling here.
    <div className="pointer-events-none absolute bottom-24 right-4 z-30 flex items-center gap-2.5 transition-opacity duration-700 ease-[var(--ease-calm)]">
      {/* S2 — visible trend micro-label, in the house status/label voice (mono,
          uppercase, wide tracking, ~10px, muted haze). It sits to the LEFT of the
          orb (orb is at the right edge) and is right-anchored so it never
          overflows the viewport. It conveys TREND ONLY (reuses TREND_COPY — no
          number, bearing, identity, or per-dot link) and fades in/out calmly with
          the wrapper's ease-calm transition. It is decorative-REDUNDANT with the
          live region, so aria-hidden keeps it out of the a11y tree (the sr-only
          region remains the single announced source — no double announcement). */}
      <span
        aria-hidden
        className="whitespace-nowrap text-right font-mono text-[10px] uppercase tracking-[0.18em] text-haze-400 transition-opacity duration-700 ease-[var(--ease-calm)]"
        style={{ opacity: showLabel ? 1 : 0 }}
      >
        {present ? TREND_COPY[state.trend] : ""}
      </span>

      {/* The ambient orb. A soft signal-mint glow whose opacity reflects the
          trend intensity. Under reduced motion we hold a STABLE opacity step
          (no breathing loop); otherwise it breathes via the project's calm
          `beacon` keyframe vocabulary, scaled by intensity. aria-hidden — the
          visual is decorative; the live region below carries the meaning. */}
      <div
        aria-hidden
        className="relative flex h-12 w-12 items-center justify-center transition-opacity duration-700 ease-[var(--ease-calm)]"
        style={{ opacity: showOrb ? 1 : 0 }}
      >
        {/* Outer breathing halo — only when motion is allowed AND the orb is
            shown. Inline animation so it can be conditionally omitted; the
            globals.css reduced-motion block can't reach a JS-gated loop, which
            is exactly why we gate it on `reduceMotion` here. */}
        {showOrb && !reduceMotion && (
          <span
            className="absolute inline-flex h-full w-full rounded-full bg-signal"
            style={{
              opacity: intensity * 0.5,
              animation: "beacon 3.2s var(--ease-calm) infinite",
            }}
          />
        )}
        {/* The core dot. Its steady glow + opacity step is the reduced-motion
            channel for intensity: no loop, just a brighter/dimmer rest state. */}
        <span
          className="relative inline-flex h-3 w-3 rounded-full bg-signal shadow-glow"
          style={{ opacity: intensity }}
        />
      </div>

      {/* Accessible live region. role=status + aria-live=polite so a trend
          change is announced without interrupting. Debounced + deduped above so
          it never floods. Contains NO number, NO bearing, NO identity — just the
          honest trend phrase. Always resident (text swaps) so the announcement
          fires reliably for SR users. B1 — it is a NON-aria-hidden sibling here
          (sr-only keeps it visually invisible, NOT pruned from the a11y tree).
          S3 — blanked while hidden so no announcements fire behind the chat. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announced}
      </div>
    </div>
  );
}
