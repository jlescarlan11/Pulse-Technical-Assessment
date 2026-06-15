"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ============================================================
   Reciprocal Video copy — HONEST COPY
   Presence == "the browser tab is active". These strings must
   never imply eye/gaze tracking, watching, or that screenshots
   are prevented. Centralised so a reviewer can audit one block.

   Privacy Shield update: the WebRTC layer now keeps the
   LOCAL self-view camera track ALWAYS LIVE and gates only a
   separate clone sent to the peer. So the PiP <video> shows your
   live camera even while the OUTGOING feed is held back. The PiP
   no longer goes black — instead a compact "not shared" badge
   sits over the live self-view to explain that your camera is on
   locally but is not being SENT. The badge says the feed isn't
   being shared (true); it never claims to stop screenshots.
   ============================================================ */
const COPY = {
  // Pre-call (unchanged): before any remote stream has arrived.
  waiting: "Waiting for stranger’s video…",

  // Escalated pre-call copy. If the peer accepted video but no
  // remoteStream arrives after a grace window, the camera may be stuck. Soften
  // the wording and lean on the always-available End button instead of waiting
  // forever. Honest: it names a likely camera problem, no presence/gaze claims.
  waitingSlow: "Still waiting — they may be having camera trouble",
  waitingSlowHint: "You can leave anytime with End video below.",

  // Remote feed, mid-call, stranger's tab is inactive.
  peerAwayTitle: "Stranger stepped away",
  peerAwayBody: "Their video pauses while their tab is inactive. Audio is still connected.",

  // Privacy Shield — local PiP "not shared" badge. The self-view stays live
  // underneath; the badge is a SINGLE compact pill (icon + short label) that
  // must fit on one line at the ~128px PiP width. The full-screen overlay
  // already carries the "why", so the PiP never repeats a long explanation.
  //
  // The badge no longer renders a wrapping sub-line. Each gated case
  // picks one of these short, one-line labels. All are honest tab/presence
  // language (no gaze/screenshot claims) and short enough not to wrap; the pill
  // also truncates gracefully as a final guard.
  //
  // Default / peer-attributed case: you're present, but the outgoing feed is
  // held because the stranger stepped away.
  notSharedLabel: "Not shared",

  // Your own tab is backgrounded, so the engine stopped sending your clone.
  notSharedLocalAway: "Tab in background",

  // Pre-first-heartbeat. peerAway initialises true (fail-closed) for
  // ~1 RTT, so the outgoing clone is held before the stranger has ever been
  // seen present. Don't blame them — a neutral connecting label.
  notSharedConnecting: "Connecting…",

  // The normal "You" label on the live self-view when mutually present.
  selfLabel: "You",

  // Top HUD pill. Reads "Live" when both present; when the stranger
  // has stepped away it drops the pulse and reads a calm "Away" so the HUD
  // agrees with the full-screen "Stranger stepped away" overlay.
  pillLive: "Live",
  pillAway: "Away",

  // Aria-live announcements for presence transitions. These describe
  // sharing/presence honestly: tab/presence language, never gaze/watching.
  announcePeerAway: "Stranger stepped away. Your video is no longer shared with them while they’re away.",
  announcePeerBack: "Stranger is back. Your video is shared again.",
  announceLocalBack: "You’re back. Your video is shared again.",

  // Mute and camera controls. Honest copy: states what is sent/not sent,
  // never privacy theater ("your audio is secure"). Simple icon+label, no wrapping.
  muteLabel: "Mute",
  unmuteLabel: "Unmute",
  cameraOffLabel: "Turn off camera",
  cameraOnLabel: "Turn on camera",
  peerMutedBadge: "Muted",
  peerCameraOffBadge: "Camera off",

  // Local PiP badge when YOU turn your own camera off. The self-view
  // stays live (you still see yourself), but the peer receives black. Honest:
  // states that this view is only yours, never claims to stop recording.
  notSharedCameraOff: "Off · only you see this",
} as const;

type VideoPanelProps = {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onEnd: () => void;
  /**
   * The stranger has stepped away (their tab is hidden) or their presence is
   * unknown. The incoming remote video is already black at the source, and the
   * engine stops sending our outgoing clone.
   */
  peerAway: boolean;
  /**
   * Your tab was hidden, so the engine stopped sending your outgoing clone.
   * NOTE: the local self-view track stays live, so the PiP <video> keeps
   * showing your camera — only the feed sent to the peer is held.
   */
  localAway: boolean;
  /**
   * User manually muted audio (independent of presence gating).
   */
  isMuted: boolean;
  onToggleMute: () => void;
  /**
   * User manually turned off camera (independent of presence gating).
   */
  isCameraOn: boolean;
  onToggleCamera: () => void;
  /**
   * Peer's mute state, received via control messages.
   */
  peerMuted: boolean;
  /**
   * Peer's camera state, received via control messages.
   */
  peerCameraOn: boolean;
};

export default function VideoPanel({
  localStream,
  remoteStream,
  onEnd,
  peerAway,
  localAway,
  isMuted,
  onToggleMute,
  isCameraOn,
  onToggleCamera,
  peerMuted,
  peerCameraOn,
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
  // on, "Stranger stepped away" (mid-call) replaces the pre-call
  // "Waiting…" state even if peerAway later flips true. This is what makes
  // Distinct from the existing waiting state.
  const [hasConnected, setHasConnected] = useState(false);
  if (remoteStream && !hasConnected) setHasConnected(true);

  // peerAway initialises true (fail-closed), so a
  // fresh call could flash the "Stranger stepped away" overlay in the gap
  // between "Waiting…" and the first live frame. This latch flips true the
  // first time peerAway is observed false (i.e. the stranger was actually
  // present). The mid-call stepped-away overlay is gated on it, so a new call
  // shows waiting -> live, never waiting -> stepped-away -> live.
  //
  // Freshness per call is NOT provided by a key in page.tsx (there is
  // none). page.tsx renders VideoPanel only while video === "active", so the
  // component unmounts when the call ends and remounts on the next call — and
  // this latch, living in component state, resets naturally on that unmount.
  const [peerHasBeenPresent, setPeerHasBeenPresent] = useState(false);
  if (!peerAway && !peerHasBeenPresent) setPeerHasBeenPresent(true);

  // Announce presence transitions for screen readers. We keep the
  // previously-seen booleans in state and compare during render, publishing a
  // short, honest message into the polite aria-live region on each change.
  const [announcement, setAnnouncement] = useState("");
  const [seenPeerAway, setSeenPeerAway] = useState(peerAway);
  const [seenLocalAway, setSeenLocalAway] = useState(localAway);
  if (peerAway !== seenPeerAway) {
    setSeenPeerAway(peerAway);
    // Only narrate the stranger stepping away under the SAME condition
    // that shows the visual overlay (hasConnected && peerHasBeenPresent), so a
    // screen reader can never say "Stranger stepped away" while the screen
    // still reads "Waiting…" / "Live" pre-heartbeat. The peer's RETURN stays
    // gated on hasConnected as before.
    if (peerAway) {
      if (hasConnected && peerHasBeenPresent) setAnnouncement(COPY.announcePeerAway);
    } else if (hasConnected) {
      setAnnouncement(COPY.announcePeerBack);
    }
  }
  if (localAway !== seenLocalAway) {
    setSeenLocalAway(localAway);
    // Returning is the meaningful transition to announce for the local user.
    if (!localAway) setAnnouncement(COPY.announceLocalBack);
  }

  // Slow-connect escalation. Mirrors ChatPanel's slowConnect: if
  // the pre-call "Waiting…" state persists past a grace window with no remote
  // stream, the peer's camera may be stuck, so we soften the copy and reinforce
  // that End is available. Purely presentational; the timer is cleaned up on
  // unmount and whenever a stream arrives (the early return below skips arming
  // it). Once hasConnected latches the waiting block never renders again, so a
  // residual `true` is inert — exactly ChatPanel's connected-early-return shape,
  // with no setState inside the effect. Reduced-motion safe (no motion).
  const [slowWait, setSlowWait] = useState(false);
  useEffect(() => {
    if (remoteStream || hasConnected) return;
    const t = setTimeout(() => setSlowWait(true), 9000);
    return () => clearTimeout(t);
  }, [remoteStream, hasConnected]);

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
  // Privacy Shield: the LOCAL self-view track is always live, so the PiP
  // <video> always shows the user's camera. The engine only gates a separate
  // clone TRANSMITTED to the peer whenever localAway || peerAway. So the four
  // combinations differ only in the full-screen REMOTE overlay and in the
  // compact "not shared" BADGE laid over the (still-visible) self-view:
  //   neither           -> live remote + live self-view, just the "You" label
  //   only-peer-away     -> remote "Stranger stepped away" + PiP "Not shared"
  //   only-local-away    -> remote stays live + PiP "Tab in background"
  //   both-away          -> remote "Stranger stepped away" + PiP "Tab in background"
  // The local-away cause wins the badge because it describes YOUR own tab
  // state; the peer-attributed label is for when you're present but holding.
  //
  // Gate the mid-call overlay on peerHasBeenPresent so the fail-closed
  // initial peerAway=true never flashes the overlay before the first frame.
  const showPeerAwayOverlay = hasConnected && peerAway && peerHasBeenPresent;

  // Outgoing clone held: the self-view stays live — this only drives the
  // non-blocking "not shared" badge over the PiP. A manual camera-off
  // also holds the outgoing feed (the user turned it off on purpose), so the
  // PiP must explain that they still see themselves but the peer does not.
  const outgoingHeld = localAway || peerAway || !isCameraOn;

  // The badge must only blame the stranger once they have actually been
  // seen present — the same peerHasBeenPresent latch the full-screen overlay
  // uses. Before the first heartbeat peerAway is still its fail-closed `true`,
  // so we attribute the hold to nothing and fall through to the neutral
  // "Connecting…" label instead.
  const heldByPeer = !localAway && peerAway && peerHasBeenPresent;

  // A full-screen stepped-away overlay could otherwise
  // sit on top of an auto-calmed control bar, hiding the End button. Whenever
  // any stepped-away overlay is showing — or the remote video hasn't arrived —
  // we force the controls to stay up, mirroring the pre-stream behaviour.
  const anyAwayOverlay = showPeerAwayOverlay || outgoingHeld;
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

  // The PiP badge is a SINGLE compact pill: a short, one-line label
  // chosen by the attribution the matrix above describes. A deliberate
  // camera-off wins over everything (it's the user's own explicit action), then
  // localAway (your own tab), then the peer-attributed default once they've been
  // present; otherwise the neutral pre-heartbeat connecting label. No wrapping
  // sub-line — the full-screen overlay already conveys the "why".
  const cameraManuallyOff = !isCameraOn;
  const notSharedPillLabel = cameraManuallyOff
    ? COPY.notSharedCameraOff
    : localAway
      ? COPY.notSharedLocalAway
      : heldByPeer
        ? COPY.notSharedLabel
        : COPY.notSharedConnecting;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-ink-950"
      onPointerMove={wake}
      onPointerDown={wake}
      onKeyDown={wake}
    >
      {/* Polite presence announcer (visually hidden, SR-only). */}
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
              {/* The expanding rings animate normally, but carry a non-zero
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
            {/* Escalate after the grace window. Before that, the
                calm pre-call copy; after, softer "camera trouble" wording plus
                a hint that End is always available. aria-live=polite so a screen
                reader hears the escalation without it stealing focus; no motion,
                so it is reduced-motion safe. */}
            <div
              role="status"
              aria-live="polite"
              className="relative flex flex-col items-center gap-2 px-6 text-center"
            >
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-haze-300">
                {slowWait ? COPY.waitingSlow : COPY.waiting}
              </p>
              {slowWait && (
                <p className="max-w-xs text-xs leading-relaxed text-haze-500">
                  {COPY.waitingSlowHint}
                </p>
              )}
            </div>
          </div>
        )}

        {/* "Stranger stepped away" (mid-call). Rendered OUTSIDE the
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

        {/* Peer's mute/camera badges. Stacked in the TOP-RIGHT corner
            so they never collide with the top-left "Live"/"Away" presence pill.
            They sit OUTSIDE the auto-calm region so they stay visible without
            needing the controls up. Icon + label, same honest framing as the
            local badges. */}
        {remoteStream && (peerMuted || !peerCameraOn) && (
          <div className="pointer-events-none absolute right-4 top-4 flex flex-col items-end gap-2">
            {peerMuted && (
              <div className="flex items-center gap-1.5 rounded-full glass-faint px-3 py-1.5">
                <svg
                  className="h-3.5 w-3.5 shrink-0 text-haze-100"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  {/* Mic-off (Lucide), matches the control bar mute icon */}
                  <line x1="2" y1="2" x2="22" y2="22" />
                  <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                  <path d="M5 10v2a7 7 0 0 0 12 5" />
                  <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
                <span className="truncate font-mono text-[10px] uppercase tracking-wider text-haze-100">
                  {COPY.peerMutedBadge}
                </span>
              </div>
            )}
            {!peerCameraOn && (
              <div className="flex items-center gap-1.5 rounded-full glass-faint px-3 py-1.5">
                <svg
                  className="h-3.5 w-3.5 shrink-0 text-haze-100"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  {/* Video-off (Lucide), matches the control bar camera icon */}
                  <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8" />
                  <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10z" />
                  <line x1="2" y1="2" x2="22" y2="22" />
                </svg>
                <span className="truncate font-mono text-[10px] uppercase tracking-wider text-haze-100">
                  {COPY.peerCameraOffBadge}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Top scrim + presence indicator (auto-calms with controls).
            The pill reflects presence so the HUD agrees with the overlay:
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

        {/* Local (floating picture-in-picture) — settles in, then rests.
            Privacy Shield: the self-view track is ALWAYS LIVE, so the <video>
            keeps showing the user's camera in every state. We never cover it
            with a black box. When the outgoing clone is held (outgoingHeld) we
            lay a compact, non-blocking "not shared" badge over the bottom of
            the live face so the user knows their camera is on locally but is
            not being sent. */}
        <div className="animate-scale-in absolute bottom-28 right-4 sm:bottom-24">
          <div className="relative h-44 w-32 overflow-hidden rounded-2xl border border-haze-200/15 bg-ink-800 shadow-float">
            <video
              ref={localRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover"
            />

            {outgoingHeld ? (
              /* "Not shared" badge as a SINGLE compact pill: icon + one
                 short label, no wrapping sub-line. The live face above stays
                 fully visible; a subtle scrim strip only seats the pill for
                 legible contrast. State is conveyed by icon + text (never colour
                 alone) and every label is honest tab/presence language: the feed
                 isn't being SENT, which is true. The pill stays on one line at
                 the ~128px PiP width (max-w + truncate guard against overflow)
                 and has no motion of its own, so it is reduced-motion safe. */
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-start bg-gradient-to-t from-ink-950/85 via-ink-950/45 to-transparent px-2 pb-2 pt-6">
                <span className="flex max-w-full items-center gap-1.5 rounded-full bg-ink-950/70 px-2 py-0.5 backdrop-blur">
                  {cameraManuallyOff ? (
                    /* Slashed-camera glyph: YOU turned your camera off, so the
                       peer sees black while this self-view stays live. */
                    <svg
                      className="h-3 w-3 shrink-0 text-haze-100"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8" />
                      <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10z" />
                      <line x1="2" y1="2" x2="22" y2="22" />
                    </svg>
                  ) : (
                    /* Slashed "send" (paper-plane) glyph: marks "not being sent",
                       honest — no eye/gaze imagery. */
                    <svg
                      className="h-3 w-3 shrink-0 text-haze-100"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden
                    >
                      <path d="M4 12l15-7-4 15-3.5-5L4 12z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  )}
                  <span className="truncate font-mono text-[10px] uppercase tracking-wider text-haze-100">
                    {notSharedPillLabel}
                  </span>
                </span>
              </div>
            ) : (
              /* Mutually present and sharing live — just the normal "You" label. */
              <span className="absolute bottom-2 left-2 rounded-full bg-ink-950/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-haze-100 backdrop-blur">
                {COPY.selfLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Control bar — auto-calms, reappears on interaction or focus. While any
          stepped-away overlay is up (m1) controlsVisible is forced true, so the
          buttons stay reachable. Three buttons: Mute, Camera, End — left to right,
          with Mute and Camera using neutral accent (signal-green), End using danger-red. */}
      <div
        className={`absolute inset-x-0 bottom-0 flex justify-center gap-3 bg-gradient-to-t from-ink-950 to-transparent p-6 transition-all duration-500 ease-[var(--ease-calm)] focus-within:pointer-events-auto focus-within:translate-y-0 focus-within:opacity-100 ${
          controlsVisible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0"
        }`}
      >
        {/* Mute button — distinctive filled mic icon with slash on mute */}
        <button
          onClick={onToggleMute}
          aria-pressed={isMuted}
          aria-label={isMuted ? COPY.unmuteLabel : COPY.muteLabel}
          title={isMuted ? COPY.unmuteLabel : COPY.muteLabel}
          className="group relative flex h-14 w-14 items-center justify-center rounded-full bg-signal/20 text-signal shadow-float transition duration-300 ease-[var(--ease-spring)] hover:scale-[1.03] hover:bg-signal/30 active:scale-95"
        >
          {isMuted ? (
            <svg
              className="h-[22px] w-[22px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {/* Mic-off (Lucide): clean mic with a slash through it */}
              <line x1="2" y1="2" x2="22" y2="22" />
              <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
              <path d="M5 10v2a7 7 0 0 0 12 5" />
              <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          ) : (
            <svg
              className="h-[22px] w-[22px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {/* Mic on (Lucide): capsule + arc + stand */}
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          )}
          {/* Hover label tooltip */}
          <span className="pointer-events-none absolute -top-10 whitespace-nowrap rounded-full bg-ink-800/90 px-2 py-1 text-[11px] font-semibold text-haze-100 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            {isMuted ? COPY.unmuteLabel : COPY.muteLabel}
          </span>
        </button>

        {/* Camera toggle button — distinctive filled camera icon with slash on off */}
        <button
          onClick={onToggleCamera}
          aria-pressed={isCameraOn}
          aria-label={isCameraOn ? COPY.cameraOffLabel : COPY.cameraOnLabel}
          title={isCameraOn ? COPY.cameraOffLabel : COPY.cameraOnLabel}
          className="group relative flex h-14 w-14 items-center justify-center rounded-full bg-signal/20 text-signal shadow-float transition duration-300 ease-[var(--ease-spring)] hover:scale-[1.03] hover:bg-signal/30 active:scale-95"
        >
          {isCameraOn ? (
            <svg
              className="h-[22px] w-[22px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {/* Video on (Lucide): camera body + lens prism */}
              <path d="M22 8l-6 4 6 4V8z" />
              <rect x="2" y="6" width="14" height="12" rx="2" />
            </svg>
          ) : (
            <svg
              className="h-[22px] w-[22px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {/* Video off (Lucide): camera with a slash through it */}
              <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8" />
              <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10z" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </svg>
          )}
          {/* Hover label tooltip */}
          <span className="pointer-events-none absolute -top-10 whitespace-nowrap rounded-full bg-ink-800/90 px-2 py-1 text-[11px] font-semibold text-haze-100 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            {isCameraOn ? COPY.cameraOffLabel : COPY.cameraOnLabel}
          </span>
        </button>

        {/* End video button (danger color). Icon-only, same 56px round target as
            the mute/camera buttons — the old pill padding (px-7 py-3.5) squeezed
            the glyph out of the circle, so it's removed here. */}
        <button
          onClick={onEnd}
          className="group relative flex h-14 w-14 items-center justify-center rounded-full bg-danger text-white shadow-float transition duration-300 ease-[var(--ease-spring)] hover:scale-[1.03] hover:bg-danger-400 active:scale-95"
          aria-label="End video call"
          title="End video call"
        >
          {/* Hang-up handset (rotated 135°) — the universal end-call glyph. */}
          <svg className="h-[26px] w-[26px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path
              transform="rotate(135 12 12)"
              d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 2.99 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"
            />
          </svg>
          {/* Hover label tooltip */}
          <span className="pointer-events-none absolute -top-10 whitespace-nowrap rounded-full bg-ink-800/90 px-2 py-1 text-[11px] font-semibold text-haze-100 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            End
          </span>
        </button>
      </div>
    </div>
  );
}
