"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  FILTER_PRESETS,
  getFilterPreset,
  type FilterPresetId,
} from "@/lib/videoFilters";

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

  // Camera filters. A "filter" here is a purely COSMETIC colour-grade applied to
  // BOTH the transmitted feed and this self-view — never a privacy feature, face
  // effect, or background. The labels stay honest: "Filters" describes a look,
  // and the menu names a "look", never "privacy" / "blur" / "hide".
  filterLabel: "Camera filter",
  // Accessible name for the radiogroup of presets.
  filterGroupLabel: "Camera filter — colour grade",
  // Aria-live announcement when a filter is committed. Names the EFFECTIVE
  // grade the peer is actually receiving (honest), e.g. "Camera filter: Warm".
  announceFilterPrefix: "Camera filter: ",
  announceFilterNone: "Camera filter: off — sending unfiltered video.",
  // Honest fallback: the user asked for a non-"none" grade but setFilter()
  // reported "none" (canvas pipeline unavailable), so the peer gets plain video.
  // We say so out loud rather than silently pretending the grade applied.
  announceFilterUnavailable: "Filter unavailable — sending unfiltered video.",
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
  /**
   * The EFFECTIVE camera filter preset id currently in effect — i.e. the value
   * PeerSession.setFilter() reported is actually being transmitted, not the
   * user's last raw request. Drives both the picker's checked option and the
   * self-view colour grade, so the UI can never claim a filter the peer isn't
   * receiving. "none" => no grade (plain live camera).
   */
  selectedFilter: FilterPresetId;
  /**
   * Pick a preset. The parent routes this through PeerSession.setFilter() and
   * stores the returned EFFECTIVE id, so a browser fallback to "none" flows back
   * down as selectedFilter honestly.
   */
  onSelectFilter: (id: FilterPresetId) => void;
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
  selectedFilter,
  onSelectFilter,
}: VideoPanelProps) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const [controlsUp, setControlsUp] = useState(true);
  const calmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Filter picker open/closed. Component-local: VideoPanel unmounts when the
  // call ends (video !== "active") and remounts per call, so this latch — like
  // the away/connected latches — resets naturally per call; no manual reset.
  const [filterOpen, setFilterOpen] = useState(false);
  // Refs to each radio option so Arrow keys can move focus within the group
  // (the roving-tabindex pattern: only the checked option is in the tab order).
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Ref to the toggle button so closing the picker (Escape, outside-click, or a
  // committed pick) can return focus to it — a complete open/close focus loop.
  const filterToggleRef = useRef<HTMLButtonElement>(null);
  // Ref to the relatively-positioned wrapper that holds BOTH the toggle and the
  // popover, so outside-interaction dismissal can test "did this land inside?".
  const filterWrapRef = useRef<HTMLDivElement>(null);
  // Tracks whether the close should restore focus to the toggle. Outside-click /
  // committed-pick / Escape want focus back on the toggle; an outside-FOCUS
  // dismissal (the user tabbed elsewhere) must NOT yank focus back. Set per call
  // site, consumed by the close-focus effect below.
  const restoreFocusOnClose = useRef(false);

  // Close the picker. `restoreFocus` returns keyboard focus to the toggle
  // (Escape / committed pick / outside-click); omit it for outside-FOCUS
  // dismissal so we don't fight the user's own tab-away.
  const closeFilter = useCallback((restoreFocus: boolean) => {
    restoreFocusOnClose.current = restoreFocus;
    setFilterOpen(false);
  }, []);

  // B2: on open, move keyboard focus to the currently-checked radio option so
  // the picker is immediately operable from the keyboard. Paired with the
  // close-paths below (Escape / commit / outside-click) that return focus to the
  // toggle, this forms a complete focus loop. useLayoutEffect so focus moves in
  // the same frame the popover paints (no flash of focus on the toggle).
  useLayoutEffect(() => {
    if (!filterOpen) {
      // On close, optionally restore focus to the toggle (B1/S1). Reset the flag
      // so a later focus-out dismissal doesn't accidentally re-grab focus.
      if (restoreFocusOnClose.current) {
        restoreFocusOnClose.current = false;
        filterToggleRef.current?.focus();
      }
      return;
    }
    const checked = FILTER_PRESETS.findIndex((p) => p.id === selectedFilter);
    optionRefs.current[checked >= 0 ? checked : 0]?.focus();
    // Intentionally keyed only on filterOpen: we move focus to the checked
    // option once per open. We do NOT depend on selectedFilter here — arrow
    // roving already handles focus while open (see S1 note), and re-running on
    // every preview change would fight that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterOpen]);

  // B1: dismiss on Escape (restoring focus to the toggle) and on any
  // pointerdown / focus that lands OUTSIDE the wrapper. Both are kept so mouse
  // and keyboard users are covered. Listeners are attached only while the picker
  // is open and torn down on close / unmount.
  useEffect(() => {
    if (!filterOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeFilter(true);
      }
    };
    const onOutside = (e: Event) => {
      const wrap = filterWrapRef.current;
      if (wrap && !wrap.contains(e.target as Node)) {
        // pointerdown outside => mouse/touch dismissal: pull focus back to the
        // toggle so keyboard users who then tab land predictably. A focusin
        // outside => the user already moved focus elsewhere; don't yank it back.
        closeFilter(e.type === "pointerdown");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [filterOpen, closeFilter]);

  // Arrow-key roving within the radiogroup. Enter/Space selection is handled by
  // the native <button>'s onClick (see commitSelect); here we add Left/Up and
  // Right/Down to move (and PREVIEW) between options, wrapping at the ends — the
  // standard radiogroup interaction.
  //
  // S1 — DELIBERATE ASYMMETRY: arrow roving applies the preset (live preview)
  // but does NOT close the picker, so the user can roam across presets and
  // compare looks. Only a COMMITTED pick (pointer-click or Enter/Space, both via
  // commitSelect) closes the picker and returns focus to the toggle. Do not
  // "fix" arrow keys to close on each move — that would break previewing.
  // S3 — remember the user's last REQUESTED preset id so we can detect the
  // honest canvas-unavailable fallback: a non-"none" request that comes back as
  // an effective `selectedFilter` of "none" means the peer is getting unfiltered
  // video, and the announcer must say so rather than imply the grade applied.
  // Kept as STATE (not a ref) because it is read during render in the S3 compare
  // below — react-hooks/refs forbids reading ref.current during render.
  const [lastRequested, setLastRequested] = useState<FilterPresetId>(selectedFilter);

  // Every preset request (arrow-preview AND committed pick) routes through here
  // so lastRequested stays accurate for the S3 announcement comparison. This
  // does NOT close the picker — closing is a separate, commit-only concern (S1).
  const requestFilter = useCallback(
    (id: FilterPresetId) => {
      setLastRequested(id);
      onSelectFilter(id);
    },
    [onSelectFilter],
  );

  const onRadioKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      const last = FILTER_PRESETS.length - 1;
      let next = index;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = index === last ? 0 : index + 1;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = index === 0 ? last : index - 1;
      else return;
      e.preventDefault();
      const preset = FILTER_PRESETS[next];
      // Preview the roamed-to preset; intentionally does NOT close (S1).
      requestFilter(preset.id);
      optionRefs.current[next]?.focus();
    },
    [requestFilter],
  );

  // S1 — commit a pick (pointer-click OR Enter/Space, both fire the button's
  // onClick): apply the preset, then close the picker and return focus to the
  // toggle. Arrow roving above intentionally does NOT route through here.
  const commitSelect = useCallback(
    (id: FilterPresetId) => {
      requestFilter(id);
      closeFilter(true);
    },
    [requestFilter, closeFilter],
  );

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

  // S3 — announce the EFFECTIVE camera filter into the same polite region. We
  // key the compare on the (requested, effective) PAIR, not on `selectedFilter`
  // alone, because the HONEST fallback case never changes the effective id: the
  // user asks for "Night" but setFilter() reports "none" (canvas pipeline
  // unavailable), so `selectedFilter` stays "none" while `lastRequested` flips.
  // Tracking both lets us announce "Filter unavailable — sending unfiltered
  // video." for that fallback, the plain "filter off" message for a deliberate
  // "None" pick, and the named grade otherwise — never implying a grade the peer
  // isn't receiving.
  const [seenRequested, setSeenRequested] = useState(lastRequested);
  const [seenEffective, setSeenEffective] = useState(selectedFilter);
  if (lastRequested !== seenRequested || selectedFilter !== seenEffective) {
    setSeenRequested(lastRequested);
    setSeenEffective(selectedFilter);
    if (selectedFilter === "none") {
      setAnnouncement(
        lastRequested !== "none"
          ? COPY.announceFilterUnavailable
          : COPY.announceFilterNone,
      );
    } else {
      // Title-case the uppercase preset label for a natural spoken name, e.g.
      // "NIGHT" -> "Night" => "Camera filter: Night".
      const label = getFilterPreset(selectedFilter).label;
      const spoken = label.charAt(0) + label.slice(1).toLowerCase();
      setAnnouncement(COPY.announceFilterPrefix + spoken);
    }
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
  // An OPEN filter picker also forces the controls up — mirroring how the
  // away-overlays force them up — so the 3.5s auto-calm recede timer can never
  // hide the control bar (and the picker rooted in it) mid-selection.
  const forceControls = !remoteStream || anyAwayOverlay || filterOpen;
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

  // S4 — derive the active-filter signals once. `filterActive` is the
  // separately-legible "a non-none grade is in effect" state (distinct from the
  // picker's open/closed state); `activeShortName` is the title-cased preset name
  // used in the toggle's aria-label and tooltip so the active look is named.
  const filterActive = selectedFilter !== "none";
  const activeFilterLabel = getFilterPreset(selectedFilter).label;
  const activeShortName =
    activeFilterLabel.charAt(0) + activeFilterLabel.slice(1).toLowerCase();

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
              // Story 3 — honest self-view: paint the SAME colour-grade currently
              // transmitted, reusing the shared css from getFilterPreset() (never
              // a hand-written filter string) so preview and transmit can't drift.
              // selectedFilter is the EFFECTIVE id, so a fallback to "none" => ""
              // => plain live camera. Presentational ONLY: it never gates, freezes
              // or blacks out the self-view — the track stays live in every gated
              // state exactly as before; only the colour grade changes.
              style={{ filter: getFilterPreset(selectedFilter).css || undefined }}
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
        {/* Filter control. A relatively-positioned wrapper anchors the popover
            picker ABOVE the button. The button toggles the picker; while the
            picker is open `filterOpen` forces the control bar to stay up (see
            forceControls), so the auto-calm recede timer can never hide it
            mid-selection — mirroring how the away-overlays force controls up.
            Cosmetic only: state is conveyed by icon + the active label, never
            colour alone. */}
        <div ref={filterWrapRef} className="relative">
          {filterOpen && (
            /* Preset picker. RADIO GROUP (stakeholder hard requirement): the
               four presets are mutually exclusive, so role="radiogroup" +
               role="radio"/aria-checked, NOT aria-pressed toggles. Roving
               tabindex: only the checked option is tabbable; Arrow keys move
               within the group (onRadioKeyDown) and Enter/Space select via the
               native button. Glass surface, mono uppercase labels, signal accent
               on the ACTIVE preset. The open/close uses a transition that globals
               collapse under prefers-reduced-motion (no bespoke motion here). */
            <div
              role="radiogroup"
              aria-label={COPY.filterGroupLabel}
              // S2 — stacking + small-screen clamp. z-50 lifts the popover ABOVE
              // the PiP self-view and the full-screen away scrim (both within the
              // z-40 panel root) so it stays visible while showPeerAwayOverlay is
              // up (the bar is force-shown via forceControls). The width is capped
              // to the viewport (min(11rem, calc(100vw-2rem))) and the centered
              // -translate-x-1/2 is clamped so at ~320px it can't clip off-screen
              // or collide with the right-anchored PiP.
              className="animate-fade-up glass absolute bottom-[4.5rem] left-1/2 z-50 flex w-[min(11rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-1 rounded-2xl p-2 shadow-float"
            >
              {FILTER_PRESETS.map((preset, i) => {
                const active = preset.id === selectedFilter;
                return (
                  <button
                    key={preset.id}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => commitSelect(preset.id)}
                    onKeyDown={(e) => onRadioKeyDown(e, i)}
                    className={`flex items-center justify-between rounded-xl px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition duration-200 ease-[var(--ease-calm)] ${
                      active
                        ? "bg-signal/20 text-signal"
                        : "text-haze-200 hover:bg-haze-200/10 hover:text-haze-50"
                    }`}
                  >
                    <span className="truncate">{preset.label}</span>
                    {/* Checkmark on the active preset — state by icon + accent,
                        never colour alone. */}
                    {active && (
                      <svg
                        className="h-3.5 w-3.5 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <button
            ref={filterToggleRef}
            type="button"
            // Toggle open/closed. Closing here is a deliberate dismissal, so keep
            // focus on this toggle (restoreFocus stays moot — focus is already
            // here). Opening hands focus to the checked option (B2 effect).
            onClick={() => (filterOpen ? closeFilter(true) : setFilterOpen(true))}
            aria-haspopup="true"
            aria-expanded={filterOpen}
            aria-label={
              // S4 — name the ACTIVE grade in the accessible label so the
              // active-filter state is legible to screen readers too, separate
              // from aria-expanded (which carries open/closed).
              filterActive
                ? `${COPY.filterLabel} (${activeShortName} active)`
                : COPY.filterLabel
            }
            title={COPY.filterLabel}
            // S4 — "open" and "filter-active" are now DISTINCT signals:
            //   • open      => brighter signal fill (bg-signal/30), driven by
            //                  filterOpen and mirrored by aria-expanded.
            //   • active    => a non-colour-only ring (ring-1 ring-signal) PLUS a
            //                  small filled dot badge below, so a non-"none" grade
            //                  reads as active even at low colour perception.
            // The old 10%-opacity-bump-only marker conflated the two and failed
            // the state-by-more-than-colour rule.
            className={`group relative flex h-14 w-14 items-center justify-center rounded-full shadow-float transition duration-300 ease-[var(--ease-spring)] hover:scale-[1.03] active:scale-95 ${
              filterOpen ? "bg-signal/30 text-signal" : "bg-signal/20 text-signal hover:bg-signal/30"
            } ${filterActive ? "ring-1 ring-signal" : ""}`}
          >
            {/* Sliders / adjustments glyph (Lucide stroke style), matching the
                mic/camera SVGs — a colour-grade control, no privacy/eye imagery. */}
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
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
            {/* S4 — filled dot badge marking an ACTIVE non-"none" grade. A shape,
                not just a tint — legible regardless of colour perception. Ringed
                in the bar background so it reads against the button fill. */}
            {filterActive && (
              <span
                aria-hidden
                className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-signal ring-2 ring-ink-950"
              />
            )}
            {/* Hover label tooltip — names the active grade when one is applied,
                so the look is legible without opening the picker. */}
            <span className="pointer-events-none absolute -top-10 whitespace-nowrap rounded-full bg-ink-800/90 px-2 py-1 text-[11px] font-semibold text-haze-100 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              {filterActive ? `${COPY.filterLabel}: ${activeShortName}` : COPY.filterLabel}
            </span>
          </button>
        </div>

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
