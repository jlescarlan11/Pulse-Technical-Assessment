import { useEffect, useRef, useState } from "react";
import type { PeerSession } from "@/lib/webrtc";
import type { VideoState } from "../state/videoReducer";
import { DEFAULT_FILTER_ID, type FilterPresetId } from "@/lib/videoFilters";
import { useRefState } from "./useRefState";

// ── Reciprocal Video (mutual-presence) tuning ──
const AWAY_DEBOUNCE_MS = 500; // tab must stay hidden this long before cutting
const RESUME_DELAY_MS = 150; // settle before re-showing once mutually present
const HEARTBEAT_INTERVAL_MS = 2_000; // presence ping cadence while present
const HEARTBEAT_TIMEOUT_MS = 4_000; // no ping within this ⇒ peer treated as away

export interface UseReciprocalVideo {
  // ── presence + manual-control state (read by the render / VideoPanel) ──
  localAway: boolean;
  peerAway: boolean;
  isMuted: boolean;
  isCameraOn: boolean;
  peerMuted: boolean;
  peerCameraOn: boolean;
  // EFFECTIVE camera filter (cosmetic colour-grade) actually in effect.
  selectedFilter: FilterPresetId;
  // ── user toggles (wired to VideoPanel) ──
  toggleMute: () => void;
  toggleCamera: () => void;
  selectFilter: (id: FilterPresetId) => void;
  // ── inbound control-message handlers (called from page's handleControl) ──
  // The caller guards these on video === "active"; they update presence state
  // and re-apply the gate.
  notePeerPresent: () => void;
  notePeerAway: () => void;
  setPeerMuted: (muted: boolean) => void;
  setPeerCameraOn: (on: boolean) => void;
  // ── lifecycle ──
  resetPresence: () => void; // video end / remote video-end
  resetControls: () => void; // full teardown: mute/camera back to defaults
}

// The reciprocal-video privacy engine: the mutual-presence shield plus the
// manual mute/camera controls, extracted whole from the page.
//
// While a video call is active, clear video is transmitted only while BOTH tabs
// are present. Either side switching away (tab hidden / pagehide) cuts the
// OUTGOING video at the source, so a present user can never watch or record a
// clear feed of an absent stranger. Audio is untouched. Presence is exchanged
// as data-channel heartbeats; a fail-closed staleness check treats a silent
// peer as away. Detection is tab visibility only — NOT gaze.
//
// Receives the shared peerRef (R7) and the current `video` state (the presence
// effect runs only while "active"). The outgoing track is the protective core:
// the gate flips its .enabled, which the media pipeline enforces regardless of
// tab state.
export function useReciprocalVideo(
  peerRef: React.RefObject<PeerSession | null>,
  video: VideoState,
): UseReciprocalVideo {
  // Mute/camera controls. Track the user's manual audio/video toggles.
  // isMuted: audio track disabled. isCameraOn: video track the user WANTS sent.
  //
  // Camera is mirrored into a ref because the presence gate (applyVideoGate) —
  // which runs on every 2s heartbeat — must read the latest manual intent to
  // decide whether to (re)enable the outgoing track. The outgoing video is
  // gated on BOTH mutual presence AND this manual intent.
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, cameraOnRef, setIsCameraOn] = useRefState(true);
  // Peer's mute/camera state, set from inbound control messages.
  const [peerMuted, setPeerMuted] = useState(false);
  const [peerCameraOn, setPeerCameraOn] = useState(true);

  // Camera filter (cosmetic colour-grade). Holds the EFFECTIVE preset id — the
  // one PeerSession.setFilter() reported actually in effect — never the user's
  // raw request. So if the browser can't build the canvas pipeline and the
  // engine falls back to "none", this state reflects that honest fallback and
  // the picker/self-view never claim a grade the peer isn't receiving. No
  // persistence: each call starts at DEFAULT_FILTER_ID and resetControls() (on
  // teardown) resets it, consistent with the app's no-persistence model.
  const [selectedFilter, setSelectedFilter] =
    useState<FilterPresetId>(DEFAULT_FILTER_ID);

  // localAway: this tab has stepped away (hidden/pagehide). peerAway: the
  // stranger has — fail-closed (assume away until the first heartbeat arrives).
  // Mirrored into refs so the heartbeat interval and the control handler read
  // the latest value without re-subscribing.
  const [localAway, localAwayRef, setLocalAway] = useRefState(false);
  // peerAway seeds fail-closed (true): assume the stranger is away until the
  // first heartbeat proves otherwise, so no clear feed ever leaks at call start.
  const [peerAway, peerAwayRef, setPeerAway] = useRefState(true);

  const lastPeerPresentAt = useRef(0); // 0 = never heard from the peer yet
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Gate the OUTGOING video track on mutual presence (the protective core).
  // Cutting is instant — close the one-sided window immediately; resuming waits
  // RESUME_DELAY_MS and re-checks mutual presence at fire time to avoid strobing
  // on rapid flaps. Disabling the track yields black frames at the source, so an
  // absent/lurking peer's recorder captures nothing recognizable.
  function applyVideoGate() {
    const ps = peerRef.current;
    if (!ps) return;
    if (resumeTimer.current) {
      clearTimeout(resumeTimer.current);
      resumeTimer.current = null;
    }
    // The outgoing video may only flow when BOTH the presence shield is
    // satisfied (mutually present) AND the user hasn't manually turned their
    // camera off. The manual intent is read from a ref so the 2s heartbeat,
    // which calls this, never re-enables a track the user explicitly cut.
    const mutuallyPresent = !localAwayRef.current && !peerAwayRef.current;
    const shouldSend = mutuallyPresent && cameraOnRef.current;
    if (!shouldSend) {
      // Cutting is instant — manual-off or an absent peer both close the window
      // immediately with no resume delay.
      ps.setOutgoingVideoEnabled(false);
    } else {
      resumeTimer.current = setTimeout(() => {
        resumeTimer.current = null;
        if (!localAwayRef.current && !peerAwayRef.current && cameraOnRef.current) {
          peerRef.current?.setOutgoingVideoEnabled(true);
        }
      }, RESUME_DELAY_MS);
    }
  }

  // applyVideoGate is recreated each render; read it through a ref inside the
  // heartbeat interval and the control handlers so effect deps stay honest and
  // the interval isn't torn down on every render.
  const applyVideoGateRef = useRef(applyVideoGate);
  useEffect(() => {
    applyVideoGateRef.current = applyVideoGate;
  });

  // Reset all presence state so it never leaks into the next call.
  function resetPresence() {
    if (resumeTimer.current) {
      clearTimeout(resumeTimer.current);
      resumeTimer.current = null;
    }
    setLocalAway(false);
    setPeerAway(true); // back to fail-closed for the next call
    lastPeerPresentAt.current = 0;
  }

  // Reset manual mute/camera/filter state on full teardown.
  function resetControls() {
    setIsMuted(false);
    setIsCameraOn(true);
    setPeerMuted(false);
    setPeerCameraOn(true);
    setSelectedFilter(DEFAULT_FILTER_ID);
  }

  function toggleMute() {
    const ps = peerRef.current;
    if (!ps) return;
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    ps.setOutgoingAudioEnabled(!newMuted);
    ps.sendControl(newMuted ? "audio-mute" : "audio-unmute");
  }

  function toggleCamera() {
    const ps = peerRef.current;
    if (!ps) return;
    const newCameraOn = !isCameraOn;
    setIsCameraOn(newCameraOn);
    // Route through the gate rather than toggling the track directly: it folds
    // the new manual intent together with mutual presence, so turning the camera
    // "on" while the peer is away stays shielded, and turning it "off" cuts
    // instantly regardless of presence. cameraOnRef is already updated above.
    applyVideoGate();
    ps.sendControl(newCameraOn ? "video-manual-on" : "video-manual-off");
  }

  // Pick a camera filter. Honest-state binding (hard requirement): set React
  // state from setFilter()'s RETURN VALUE — the EFFECTIVE id the engine applied,
  // not the requested one. If the canvas pipeline can't be built the engine
  // returns "none" and the picker + self-view fall back honestly, never showing
  // a grade the peer isn't actually receiving. Guards a null peer exactly like
  // toggleMute / toggleCamera. Cosmetic only: never touches the presence gate.
  function selectFilter(id: FilterPresetId) {
    const ps = peerRef.current;
    if (!ps) return;
    const effective = ps.setFilter(id);
    setSelectedFilter(effective);
  }

  // The stranger's tab is active again (also the periodic heartbeat).
  function notePeerPresent() {
    lastPeerPresentAt.current = Date.now();
    if (peerAwayRef.current) setPeerAway(false);
    applyVideoGateRef.current();
  }

  // The stranger switched away — cut our outgoing feed immediately.
  function notePeerAway() {
    if (!peerAwayRef.current) setPeerAway(true);
    applyVideoGateRef.current();
  }

  // ── mutual-presence engine: active only while video === "active" ──
  useEffect(() => {
    if (video !== "active") return;
    let awayTimer: ReturnType<typeof setTimeout> | undefined;

    const goAway = () => {
      awayTimer = undefined;
      if (localAwayRef.current) return;
      setLocalAway(true);
      peerRef.current?.sendControl("presence-away");
      applyVideoGateRef.current();
    };

    const comeBack = () => {
      if (awayTimer) {
        clearTimeout(awayTimer);
        awayTimer = undefined;
      }
      if (localAwayRef.current) setLocalAway(false);
      peerRef.current?.sendControl("presence-present");
      applyVideoGateRef.current();
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (!awayTimer) awayTimer = setTimeout(goAway, AWAY_DEBOUNCE_MS);
      } else {
        comeBack();
      }
    };

    // pagehide is the most dangerous "absent" state — cut instantly, no debounce.
    const onPageHide = () => {
      if (localAwayRef.current) return;
      setLocalAway(true);
      peerRef.current?.sendControl("presence-away");
      applyVideoGateRef.current();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    // beforeunload too, so a hard close/navigation cuts instantly rather than
    // waiting out the ~HEARTBEAT_TIMEOUT_MS staleness window on the peer.
    window.addEventListener("beforeunload", onPageHide);

    // Announce presence immediately so the peer clears its fail-closed default
    // within ~1 RTT instead of waiting a full heartbeat interval — otherwise the
    // call would start with both feeds black for up to HEARTBEAT_INTERVAL_MS.
    peerRef.current?.sendControl("presence-present");
    // Enforce the initial gate: the peer starts fail-closed, so hold our video
    // until the first heartbeat confirms mutual presence.
    applyVideoGateRef.current();

    const heartbeat = setInterval(() => {
      if (!localAwayRef.current) {
        peerRef.current?.sendControl("presence-present");
      }
      // Fail-closed staleness: peer silent past the timeout ⇒ treat as away.
      const last = lastPeerPresentAt.current;
      const stale = last === 0 || Date.now() - last > HEARTBEAT_TIMEOUT_MS;
      if (stale && !peerAwayRef.current) {
        setPeerAway(true);
        applyVideoGateRef.current();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // If the tab is already hidden when the call starts, go away immediately —
    // no debounce on the initial state (the debounce only guards mid-call flaps).
    if (document.visibilityState === "hidden") {
      goAway();
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
      clearInterval(heartbeat);
      if (awayTimer) clearTimeout(awayTimer);
    };
    // CRITICAL: this effect must re-run ONLY when `video` changes — re-running
    // re-arms the heartbeat and re-sends presence. setLocalAway/setPeerAway
    // (useRefState setters) and localAwayRef/peerAwayRef (useRefState refs) are
    // all referentially stable hook returns, so adding them (and peerRef, a
    // stable ref) satisfies exhaustive-deps WITHOUT introducing an extra re-run
    // trigger.
  }, [video, peerRef, setLocalAway, setPeerAway, localAwayRef, peerAwayRef]);

  return {
    localAway,
    peerAway,
    isMuted,
    isCameraOn,
    peerMuted,
    peerCameraOn,
    selectedFilter,
    toggleMute,
    toggleCamera,
    selectFilter,
    notePeerPresent,
    notePeerAway,
    setPeerMuted,
    setPeerCameraOn,
    resetPresence,
    resetControls,
  };
}
