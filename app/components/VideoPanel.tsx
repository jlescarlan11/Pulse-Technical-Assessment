"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ============================================================
   Phase 4 — Reciprocal Video copy (Story 6: HONEST COPY)
   Presence == "the browser tab is active". These strings must
   never imply eye/gaze tracking, watching, or that screenshots
   are prevented. Centralised so a reviewer can audit one block.
   ============================================================ */
const COPY = {
  // Pre-call (unchanged): before any remote stream has arrived.
  waiting: "Waiting for stranger’s video…",

  // Story 4 — remote feed, mid-call, stranger's tab is inactive.
  peerAwayTitle: "Stranger stepped away",
  peerAwayBody: "Their video pauses while their tab is inactive. Audio is still connected.",

  // Story 5 — local PiP, your tab is inactive. Sub-line names the
  // mechanism (this tab is backgrounded) so the pause is self-evident.
  localAwayTitle: "You stepped away",
  localAwaySub: "Paused while this tab is in the background · audio still on",

  // Story 5 — you're present but the stranger left, so your outgoing
  // video is held back too. Quieter treatment, but the sub-line clearly
  // attributes the cause to the stranger so it ties to the big overlay.
  localPausedTitle: "Paused",
  localPausedSub: "Held while they’re away · camera resumes when they’re back",

  // M5 — top HUD pill. Reads "Live" when both present; when the stranger
  // has stepped away it drops the pulse and reads a calm "Away" so the HUD
  // agrees with the full-screen "Stranger stepped away" overlay.
  pillLive: "Live",
  pillAway: "Away",

  // Story 7 — aria-live announcements for presence transitions.
  announcePeerAway: "Stranger stepped away",
  announcePeerBack: "Stranger is back",
  announceLocalBack: "You’re back",
} as const;

type VideoPanelProps = {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onEnd: () => void;
  /**
   * The stranger has stepped away (their tab is hidden) or their presence is
   * unknown. The incoming remote video is already black at the source.
   */
  peerAway: boolean;
  /**
   * Your tab was hidden, so the engine disabled your outgoing video track —
   * your self-view is black too.
   */
  localAway: boolean;
};

export default function VideoPanel({
  localStream,
  remoteStream,
  onEnd,
  peerAway,
  localAway,
}: VideoPanelProps) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const [controlsUp, setControlsUp] = useState(true);
  const calmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Presence-derived state, computed by adjusting state during render when the
  // incoming props change (React's "you might not need an effect" pattern) —
  // no setState-in-effect and no ref reads during render.
  //
  // hasConnected: latches true once a remote stream has ever arrived. From then
  // on, "Stranger stepped away" (mid-call, Story 4) replaces the pre-call
  // "Waiting…" state even if peerAway later flips true. This is what makes
  // Story 4 distinct from the existing waiting state.
  const [hasConnected, setHasConnected] = useState(false);
  if (remoteStream && !hasConnected) setHasConnected(true);

  // M3 (call-start flicker): peerAway initialises true (fail-closed), so a
  // fresh call could flash the "Stranger stepped away" overlay in the gap
  // between "Waiting…" and the first live frame. This latch flips true the
  // first time peerAway is observed false (i.e. the stranger was actually
  // present). The mid-call stepped-away overlay is gated on it, so a new call
  // shows waiting -> live, never waiting -> stepped-away -> live. The latch
  // lives in component state and resets naturally on unmount, and page.tsx
  // keys this panel to the active video session, so each call starts fresh.
  const [peerHasBeenPresent, setPeerHasBeenPresent] = useState(false);
  if (!peerAway && !peerHasBeenPresent) setPeerHasBeenPresent(true);

  // Story 7 — announce presence transitions for screen readers. We keep the
  // previously-seen booleans in state and compare during render, publishing a
  // short, honest message into the polite aria-live region on each change.
  const [announcement, setAnnouncement] = useState("");
  const [seenPeerAway, setSeenPeerAway] = useState(peerAway);
  const [seenLocalAway, setSeenLocalAway] = useState(localAway);
  if (peerAway !== seenPeerAway) {
    setSeenPeerAway(peerAway);
    // Only narrate the stranger's return once a call truly existed.
    if (peerAway) setAnnouncement(COPY.announcePeerAway);
    else if (hasConnected) setAnnouncement(COPY.announcePeerBack);
  }
  if (localAway !== seenLocalAway) {
    setSeenLocalAway(localAway);
    // Returning is the meaningful transition to announce for the local user.
    if (!localAway) setAnnouncement(COPY.announceLocalBack);
  }

  useEffect(() => {
    if (localRef.current && localRef.current.srcObject !== localStream) {
      localRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteRef.current && remoteRef.current.srcObject !== remoteStream) {
      remoteRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // --- Away-combination matrix ---------------------------------------------
  // The engine disables the outgoing video track whenever localAway || peerAway,
  // so the local self-view PiP is black in BOTH cases. We render distinct,
  // honest overlays so a black box is never shown without explanation.
  //   neither           -> live remote + live self-view
  //   only-peer-away     -> remote "Stranger stepped away" + PiP "Paused"
  //   only-local-away    -> remote stays live + PiP "You stepped away"
  //   both-away          -> remote "Stranger stepped away" + PiP "You stepped away"
  // "You stepped away" takes precedence in the PiP because it describes YOUR
  // own action; the quieter "Paused" is for when you're present but holding.
  //
  // M3: gate the mid-call overlay on peerHasBeenPresent so the fail-closed
  // initial peerAway=true never flashes the overlay before the first frame.
  const showPeerAwayOverlay = hasConnected && peerAway && peerHasBeenPresent;
  const localPaused = localAway || peerAway; // outgoing track disabled here

  // m1 (no escape hatch): a full-screen stepped-away overlay could otherwise
  // sit on top of an auto-calmed control bar, hiding the End button. Whenever
  // any stepped-away overlay is showing — or the remote video hasn't arrived —
  // we force the controls to stay up, mirroring the pre-stream behaviour.
  const anyAwayOverlay = showPeerAwayOverlay || localPaused;
  const forceControls = !remoteStream || anyAwayOverlay;
  // Visible if interaction has them up OR a forced condition holds. Deriving
  // this (rather than syncing state in an effect) keeps the forced-up cases
  // truthful without cascading renders.
  const controlsVisible = controlsUp || forceControls;

  // Controls auto-calm: surface them on any interaction, then recede after a
  // few idle seconds — but only when nothing is forcing them up.
  const wake = useCallback(() => {
    setControlsUp(true);
    if (calmTimer.current) clearTimeout(calmTimer.current);
    if (!forceControls) {
      calmTimer.current = setTimeout(() => setControlsUp(false), 3500);
    }
  }, [forceControls]);

  // Start the idle recede countdown only when nothing is forcing the controls
  // up. When a forced condition is active we simply skip the timer; visibility
  // is handled by the derived controlsVisible, so no setState runs here.
  useEffect(() => {
    if (forceControls) return;
    const t = setTimeout(() => setControlsUp(false), 3500);
    return () => clearTimeout(t);
  }, [forceControls]);

  useEffect(
    () => () => {
      if (calmTimer.current) clearTimeout(calmTimer.current);
    },
    [],
  );

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-ink-950"
      onPointerMove={wake}
      onPointerDown={wake}
      onKeyDown={wake}
    >
      {/* Story 7 — polite presence announcer (visually hidden, SR-only). */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="relative flex-1 overflow-hidden">
        {/* Remote (full screen) */}
        <video
          ref={remoteRef}
          autoPlay
          playsInline
          className="h-full w-full bg-ink-900 object-cover"
        />

        {/* Designed waiting state — pre-call only (no stream has arrived yet). */}
        {!remoteStream && !hasConnected && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-ink-950">
            <div className="aurora-field opacity-40" />
            <div className="relative flex h-28 w-28 items-center justify-center">
              {/* M4 — the expanding rings animate normally, but carry a non-zero
                  resting opacity so prefers-reduced-motion (which freezes the
                  animation on frame 0) still leaves a visible static halo. */}
              {[0, 1.4].map((d) => (
                <span
                  key={d}
                  className="absolute h-16 w-16 rounded-full border-2 border-signal/40 opacity-60"
                  style={{
                    animation: "beacon 3.2s var(--ease-calm) infinite",
                    animationDelay: `${d}s`,
                  }}
                />
              ))}
              <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-signal/15 text-signal">
                <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="3" y="6" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M15 10.5l5-2.8v8.6l-5-2.8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              </span>
            </div>
            <p className="relative font-mono text-xs uppercase tracking-[0.18em] text-haze-300">
              {COPY.waiting}
            </p>
          </div>
        )}

        {/* Story 4 — "Stranger stepped away" (mid-call). Rendered OUTSIDE the
            controls-calm block so the auto-calm timer can never hide it. Blur +
            darken + icon + text; reduced-motion users get the same overlay with
            the crossfade collapsed by globals.css (no looping animation here). */}
        {showPeerAwayOverlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center transition-opacity duration-300 ease-[var(--ease-calm)]">
            {/* Darkened, blurred scrim over the (already-black) remote feed. */}
            <div className="absolute inset-0 bg-ink-950/80 backdrop-blur-xl" />
            <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-haze-200/10 text-haze-200 ring-1 ring-inset ring-haze-200/15">
              {/* Person stepping away glyph — state conveyed by icon + text, not blur alone. */}
              <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="9" cy="7" r="3.2" stroke="currentColor" strokeWidth="1.6" />
                <path d="M3.5 19c0-3.3 2.6-5.6 5.5-5.6 1.2 0 2.3.4 3.2 1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <path d="M15.5 9.5l4 2.5-4 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            </span>
            <div className="relative flex flex-col items-center gap-2">
              <p className="text-base font-semibold text-haze-50">{COPY.peerAwayTitle}</p>
              <p className="max-w-xs text-sm leading-relaxed text-haze-300">{COPY.peerAwayBody}</p>
            </div>
          </div>
        )}

        {/* Top scrim + presence indicator (auto-calms with controls).
            M5 — the pill reflects presence so the HUD agrees with the overlay:
            mutually present => pulsing "Live" (danger dot); stranger away =>
            calm, dimmed "Away" with a steady (non-pulsing) haze dot, conveyed
            by icon + text, never colour alone. */}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-4 transition-all duration-500 ease-[var(--ease-calm)] ${
            controlsVisible ? "opacity-100" : "-translate-y-2 opacity-0"
          }`}
        >
          {showPeerAwayOverlay ? (
            <span className="glass-faint flex items-center gap-2 rounded-full px-3 py-1.5 opacity-70">
              <span className="h-2 w-2 rounded-full bg-haze-400" />
              <span className="font-mono text-[11px] uppercase tracking-wider text-haze-300">
                {COPY.pillAway}
              </span>
            </span>
          ) : (
            <span className="glass-faint flex items-center gap-2 rounded-full px-3 py-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
              <span className="font-mono text-[11px] uppercase tracking-wider text-haze-100">
                {COPY.pillLive}
              </span>
            </span>
          )}
        </div>

        {/* Local (floating picture-in-picture) — settles in, then rests */}
        <div className="animate-scale-in absolute bottom-28 right-4 sm:bottom-24">
          <div className="relative h-44 w-32 overflow-hidden rounded-2xl border border-haze-200/15 bg-ink-800 shadow-float">
            <video
              ref={localRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover"
            />

            {/* Story 5 — local PiP overlays. The outgoing track is disabled
                whenever localAway || peerAway, so the self-view is black; we
                explain which case it is rather than show a bare black box. */}
            {localPaused && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/85 px-3 text-center backdrop-blur-md transition-opacity duration-300 ease-[var(--ease-calm)]">
                {localAway ? (
                  <>
                    {/* You stepped away — paused-camera glyph + honest sub-line. */}
                    <svg className="h-6 w-6 text-haze-200" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <rect x="3" y="6.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
                      <path d="M14 11l5.5-3v8l-5.5-3" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                      <path d="M9 10v4M11.5 10v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    <p className="text-[11px] font-semibold leading-tight text-haze-50">
                      {COPY.localAwayTitle}
                    </p>
                    <p className="text-[10px] leading-tight text-haze-300">
                      {COPY.localAwaySub}
                    </p>
                  </>
                ) : (
                  <>
                    {/* You're present but the stranger left — quieter hold; the
                        sub-line attributes the cause to the stranger, tying this
                        PiP to the big "Stranger stepped away" overlay. */}
                    <svg className="h-5 w-5 text-haze-300" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path d="M9 8v8M15 8v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                    <p className="text-[11px] font-semibold leading-tight text-haze-100">
                      {COPY.localPausedTitle}
                    </p>
                    <p className="text-[10px] leading-tight text-haze-400">
                      {COPY.localPausedSub}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          <span className="absolute bottom-2 left-2 rounded-full bg-ink-950/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-haze-100 backdrop-blur">
            You
          </span>
        </div>
      </div>

      {/* Control bar — auto-calms, reappears on interaction or focus. While any
          stepped-away overlay is up (m1) controlsVisible is forced true, so the
          End button stays reachable. */}
      <div
        className={`absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-ink-950 to-transparent p-6 transition-all duration-500 ease-[var(--ease-calm)] focus-within:pointer-events-auto focus-within:translate-y-0 focus-within:opacity-100 ${
          controlsVisible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0"
        }`}
      >
        <button
          onClick={onEnd}
          className="flex items-center gap-2.5 rounded-full bg-danger px-7 py-3.5 font-semibold text-white shadow-float transition duration-300 ease-[var(--ease-spring)] hover:scale-[1.03] hover:bg-danger-400 active:scale-95"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 11c4.5-3 9.5-3 14 0v3l-3.5.6-.5-2.4c-2-.8-4-.8-6 0l-.5 2.4L5 14z"
              fill="currentColor"
            />
          </svg>
          End video
        </button>
      </div>
    </div>
  );
}
