"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import EntryGate from "./components/EntryGate";
import WorldMap from "./components/WorldMap";
import ConnectionPrompt from "./components/ConnectionPrompt";
import ChatPanel from "./components/ChatPanel";
import VideoPanel from "./components/VideoPanel";
import { join, leave, poll, sendSignal, UnauthorizedError } from "@/lib/api";
import { PeerSession, buildICEConfig, type DescType, type PeerControl } from "@/lib/webrtc";
import { POLL_INTERVAL_MS } from "@/lib/presence";
import { type PeerDot, type SignalMsg, type SignalType } from "@/lib/types";
import { callSign } from "@/lib/callsign";
import { useRefState } from "./hooks/useRefState";
import { useNotice } from "./hooks/useNotice";
import { useChat } from "./hooks/useChat";
import { useBlocklist } from "./hooks/useBlocklist";
import { connReducer, initialConn, type Conn } from "./state/connReducer";
import {
  videoReducer,
  initialVideo,
  type VideoState,
} from "./state/videoReducer";
import { useReciprocalVideo } from "./hooks/useReciprocalVideo";

const REQUEST_TIMEOUT_MS = 30_000;

export default function Home() {
  const [phase, setPhase] = useState<"gate" | "live">("gate");
  const [sessionId] = useState(() => crypto.randomUUID());
  // Per-session capability token issued by /api/join. Held in a ref (not state)
  // because it must be readable synchronously inside the poll interval, every
  // signal sender, and the pagehide/beforeunload leave handler — none of which
  // should re-run when it rotates. Mirrors sessionId's session-long lifetime.
  const tokenRef = useRef<string | null>(null);
  const [peers, setPeers] = useState<PeerDot[]>([]);
  // Notice / toast system (transient confirmation toast + terminal notice +
  // the Block→Undo focus safety net). The render keeps the JSX (live regions +
  // visible toast) and reads `notice`/`terminalNotice`; callers raise notices
  // via showNotice / showTerminalNotice. See useNotice for the a11y rationale.
  const {
    notice,
    terminalNotice,
    showNotice,
    dismissNotice,
    showTerminalNotice,
    undoRef,
    mainRef,
  } = useNotice();
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  // ── Origin Story ──
  // Peer coords set at the moment either party clicks "Connect". Passed to
  // WorldMap so it flies the camera to frame both dots during the handshake.
  // Cleared on teardown so the next connection gets a fresh zoom.
  const [originPeer, setOriginPeer] = useState<{ lat: number; lng: number } | null>(null);

  const [conn, connRef, setConn] = useRefState<Conn>(initialConn);
  // All connection transitions route through the pure connReducer (the state
  // machine authority). dispatchConn reads the synchronous connRef so back-to-
  // back dispatches within one tick compose correctly; setConn keeps the ref in
  // sync. Side effects stay at the call sites, gated on the same guards.
  // useCallback (over the stable setConn + connRef) so the incoming-expiry
  // effect can depend on it without re-subscribing every render.
  const dispatchConn = useCallback(
    (action: Parameters<typeof connReducer>[1]) =>
      setConn(connReducer(connRef.current, action)),
    [setConn, connRef],
  );

  const [video, videoRef, setVideo] = useRefState<VideoState>(initialVideo);
  // Video transitions route through the pure videoReducer (mirrors dispatchConn).
  const dispatchVideo = useCallback(
    (action: Parameters<typeof videoReducer>[1]) =>
      setVideo(videoReducer(videoRef.current, action)),
    [setVideo, videoRef],
  );

  const peerRef = useRef<PeerSession | null>(null);

  // Chat over the P2P data channel: message list, typing indicator, and the
  // Delivery Echo "Sent → Delivered" lifecycle. Receives the shared peerRef.
  const chat = useChat(peerRef);
  // Session-scoped, in-memory peer blocklist (discovery filter + auto-decline).
  // Destructured so the poll effect can list the stable `filterPeers` callback
  // directly (the linter tracks the object root, not `blocklist.filterPeers`).
  const { block, unblock, isBlocked, filterPeers } = useBlocklist();
  // Reciprocal-video privacy engine: the mutual-presence shield + the manual
  // mute/camera controls. Owns the [video]-keyed presence effect, the outgoing-
  // track gate, and the away/mute/camera state surfaced to VideoPanel. Receives
  // the shared peerRef and the current video state (the effect runs only while
  // "active").
  const {
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
  } = useReciprocalVideo(peerRef, video);

  const requestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-dismiss timer for an INCOMING prompt the receiver never answers. The
  // requester gives up after REQUEST_TIMEOUT_MS and tears down its peer; without
  // this, a late Connect click would accept into a stale/torn-down peer and hang
  // on a silent "Connecting…". Mirrors requestTimer's cleanup style.
  const incomingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last known location, kept in a ref so a token-refresh re-join (triggered by
  // a 401) can re-register presence with the same coordinates.
  const locationRef = useRef<{ lat: number; lng: number } | null>(null);

  // Re-mint a fresh capability token by re-joining. Called when a poll/signal
  // comes back 401 (token invalid/expired/rotated). Re-joining rotates the
  // token server-side, so we always store the newest value. Returns the new
  // token, or null if we couldn't recover (no known location / join failed).
  async function refreshToken(): Promise<string | null> {
    const loc = locationRef.current;
    if (!loc) return null;
    try {
      const { token } = await join(sessionId, loc.lat, loc.lng);
      tokenRef.current = token;
      return token;
    } catch {
      return null;
    }
  }

  // Token-aware signal sender. Pulls the current token from the ref, and on a
  // 401 re-mints it once and retries so a rotated/expired token doesn't drop
  // the message silently.
  async function emitSignal(
    toId: string,
    type: SignalType,
    payload?: string,
  ): Promise<void> {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await sendSignal(sessionId, toId, type, token, payload);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        const fresh = await refreshToken();
        if (fresh) {
          try {
            await sendSignal(sessionId, toId, type, fresh, payload);
          } catch {}
        }
      }
    }
  }

  function teardown(message?: string) {
    if (requestTimer.current) clearTimeout(requestTimer.current);
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
    peerRef.current?.close();
    peerRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    dispatchVideo({ type: "END" });
    resetPresence();
    chat.reset();
    setOriginPeer(null);
    resetControls();
    dispatchConn({ type: "RESET" });
    if (message) showNotice(message);
  }

  async function startPeer(peerId: string, initiator: boolean) {
    try {
      const iceConfig = await buildICEConfig(
        sessionId,
        tokenRef.current ?? undefined,
      );
      const ps = new PeerSession(
        initiator,
        {
          onSignal: (type: DescType, payload: string) => {
            void emitSignal(peerId, type, payload);
          },
          onChat: (text) => chat.receiveMessage(text),
          onDelivered: (id) => chat.markDelivered(id),
          onControl: (ctrl) => handleControl(ctrl),
          onTyping: (on) => chat.setPeerTyping(on),
          onRemoteStream: (stream) => setRemoteStream(stream),
          onConnectionState: (state) => {
            if (state === "failed") {
              teardown("Connection failed (network).");
            }
          },
          onChannelOpen: () => {
            dispatchConn({ type: "CHANNEL_OPEN", peerId });
          },
        },
        iceConfig,
      );
      peerRef.current = ps;
    } catch {
      teardown("Connection failed (ICE config).");
    }
  }

  function handleControl(ctrl: PeerControl) {
    const ps = peerRef.current;
    switch (ctrl) {
      case "video-request":
        if (videoRef.current === "none") dispatchVideo({ type: "REQUEST_INCOMING" });
        break;
      case "video-accept":
        if (videoRef.current === "requesting" && ps) {
          ps.startVideo()
            .then((stream) => {
              setLocalStream(stream);
              dispatchVideo({ type: "ACTIVATE" });
            })
            .catch(() => {
              dispatchVideo({ type: "END" });
              ps.sendControl("video-end");
              showNotice("Camera unavailable.");
            });
        }
        break;
      case "video-decline":
        if (videoRef.current === "requesting") {
          dispatchVideo({ type: "END" });
          showNotice("Video declined.");
        }
        break;
      case "video-end":
        ps?.stopVideo();
        setLocalStream(null);
        setRemoteStream(null);
        dispatchVideo({ type: "END" });
        resetPresence();
        break;
      case "presence-present":
        // The stranger's tab is active again (also the periodic heartbeat).
        if (videoRef.current === "active") notePeerPresent();
        break;
      case "presence-away":
        // The stranger switched away — cut our outgoing feed immediately.
        if (videoRef.current === "active") notePeerAway();
        break;
      case "audio-mute":
        setPeerMuted(true);
        break;
      case "audio-unmute":
        setPeerMuted(false);
        break;
      case "video-manual-off":
        setPeerCameraOn(false);
        break;
      case "video-manual-on":
        setPeerCameraOn(true);
        break;
    }
  }

  function requestConnection(peerId: string) {
    if (connRef.current.kind !== "idle") return;
    dispatchConn({ type: "REQUEST", peerId });
    void emitSignal(peerId, "request");
    requestTimer.current = setTimeout(() => {
      if (
        connRef.current.kind === "requesting" &&
        connRef.current.peerId === peerId
      ) {
        void emitSignal(peerId, "end");
        teardown("No answer.");
      }
    }, REQUEST_TIMEOUT_MS);
  }

  function cancelRequest() {
    if (connRef.current.kind === "requesting") {
      void emitSignal(connRef.current.peerId, "end");
    }
    teardown();
  }

  function acceptIncoming() {
    if (connRef.current.kind !== "incoming") return;
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
    const peerId = connRef.current.peerId;
    const incomingPeer = peers.find((p) => p.id === peerId);
    if (incomingPeer) setOriginPeer({ lat: incomingPeer.lat, lng: incomingPeer.lng });
    void startPeer(peerId, false);
    void emitSignal(peerId, "accept");
    dispatchConn({ type: "ACCEPT_INCOMING", peerId });
  }

  function declineIncoming() {
    if (connRef.current.kind !== "incoming") return;
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
    void emitSignal(connRef.current.peerId, "decline");
    dispatchConn({ type: "RESET" });
  }

  function endConnection() {
    const c = connRef.current;
    if (c.kind === "connecting" || c.kind === "connected") {
      void emitSignal(c.peerId, "end");
    }
    teardown();
  }

  // Refuse the current peer for the rest of this session, then return
  // to the map. Mirrors endConnection: record + teardown happen UNCONDITIONALLY,
  // independent of whether the network emit lands (a refusal must never hinge on
  // the wire). We:
  //   1. capture the peer id (teardown is about to clear conn),
  //   2. add it to the in-memory blocklist (discovery filter + auto-decline read
  //      this synchronously),
  //   3. emit a graceful "end" so a well-behaved peer just sees a normal hang-up
  //      — NO "you are blocked" is ever leaked,
  //   4. teardown() to unmount ChatPanel and land back on the WorldMap,
  //   5. surface an honest, session-scoped toast WITH an Undo affordance. It's
  //      assertive (result of a destructive action) and focus moves to Undo so
  //      the 6s safety net is reachable for keyboard/SR users.
  function blockPeer() {
    const c = connRef.current;
    if (c.kind !== "connecting" && c.kind !== "connected") return;
    const peerId = c.peerId;
    block(peerId);
    void emitSignal(peerId, "end");
    teardown();
    const sign = callSign(peerId);
    showNotice(`Blocked ${sign} for this session`, {
      assertive: true,
      action: {
        label: "Undo",
        // Un-block ONLY — removing the id lets them reappear in discovery and
        // request again. It deliberately does NOT reconnect.
        onAct: () => {
          unblock(peerId);
          showNotice(`Unblocked ${sign}`);
        },
      },
    });
  }

  function startVideoRequest() {
    if (videoRef.current !== "none" || !peerRef.current) return;
    dispatchVideo({ type: "REQUEST_OUTGOING" });
    peerRef.current.sendControl("video-request");
  }

  function acceptVideo() {
    const ps = peerRef.current;
    if (!ps) return;
    ps.startVideo()
      .then((stream) => {
        setLocalStream(stream);
        ps.sendControl("video-accept");
        dispatchVideo({ type: "ACTIVATE" });
      })
      .catch(() => {
        ps.sendControl("video-decline");
        dispatchVideo({ type: "END" });
        showNotice("Camera unavailable.");
      });
  }

  function declineVideo() {
    peerRef.current?.sendControl("video-decline");
    dispatchVideo({ type: "END" });
  }

  function endVideo() {
    const ps = peerRef.current;
    ps?.stopVideo();
    ps?.sendControl("video-end");
    setLocalStream(null);
    setRemoteStream(null);
    dispatchVideo({ type: "END" });
    resetPresence();
  }

  function processSignal(sig: SignalMsg) {
    switch (sig.type) {
      case "request": {
        // A request from a blocked peer is silently auto-declined and
        // NO prompt is shown. We emit the SAME "decline" a busy/ignored request
        // produces, so it is indistinguishable from a normal decline — no
        // "you are blocked" signal is ever leaked to the peer. Checked first so
        // we never fall through to the busy path and double-emit decline.
        if (isBlocked(sig.fromId)) {
          void emitSignal(sig.fromId, "decline");
          break;
        }
        if (connRef.current.kind === "idle") {
          dispatchConn({ type: "INCOMING", peerId: sig.fromId });
        } else {
          void emitSignal(sig.fromId, "decline");
        }
        break;
      }
      case "accept": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          if (requestTimer.current) clearTimeout(requestTimer.current);
          void startPeer(sig.fromId, true);
          dispatchConn({ type: "REMOTE_ACCEPT", peerId: sig.fromId });
          // Zoom fires for the initiator only now — when the OTHER party accepts.
          // Mirrors the moment acceptIncoming() fires setOriginPeer for the recipient.
          const acceptedPeer = peers.find((p) => p.id === sig.fromId);
          if (acceptedPeer) setOriginPeer({ lat: acceptedPeer.lat, lng: acceptedPeer.lng });
        }
        break;
      }
      case "decline": {
        const c = connRef.current;
        if (c.kind === "requesting" && c.peerId === sig.fromId) {
          if (requestTimer.current) clearTimeout(requestTimer.current);
          teardown("Request declined.");
        }
        break;
      }
      case "offer":
      case "answer":
      case "ice": {
        const c = connRef.current;
        const peerId =
          c.kind === "connecting" || c.kind === "connected" ? c.peerId : null;
        if (peerRef.current && peerId === sig.fromId) {
          void peerRef.current.handleSignal(
            sig.type as DescType,
            sig.payload ?? "",
          );
        }
        break;
      }
      case "end": {
        const c = connRef.current;
        if (
          (c.kind === "incoming" ||
            c.kind === "connecting" ||
            c.kind === "connected") &&
          c.peerId === sig.fromId
        ) {
          if (c.kind === "incoming") dispatchConn({ type: "RESET" });
          else teardown("Stranger disconnected.");
        }
        break;
      }
    }
  }

  const processSignalRef = useRef(processSignal);
  useEffect(() => {
    processSignalRef.current = processSignal;
  });

  // C3 — incoming-prompt expiry. While a prompt is showing, give the receiver
  // the same budget the requester uses before it bails (REQUEST_TIMEOUT_MS).
  // Fire slightly early so a late Connect can't race the requester's teardown
  // into a dead peer. The effect's cleanup covers accept / decline / replaced-by
  // -new-request / "end"-signal dismissal — every path that leaves "incoming".
  useEffect(() => {
    if (conn.kind !== "incoming") return;
    const peerId = conn.peerId;
    incomingTimer.current = setTimeout(() => {
      if (
        connRef.current.kind === "incoming" &&
        connRef.current.peerId === peerId
      ) {
        dispatchConn({ type: "RESET" });
        showNotice("That request expired.");
      }
    }, REQUEST_TIMEOUT_MS - 2_000);
    return () => {
      if (incomingTimer.current) {
        clearTimeout(incomingTimer.current);
        incomingTimer.current = null;
      }
    };
    // showNotice and dispatchConn are stable (useCallback); connRef is a stable
    // useRefState ref. Listing them is churn-free — the effect still only
    // re-runs on a conn change.
  }, [conn, showNotice, dispatchConn, connRef]);

  // refreshToken closes over sessionId (stable) but is recreated each render;
  // read it through a ref inside the poll interval so the effect deps stay
  // honest and the interval isn't torn down/recreated needlessly.
  const refreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    refreshTokenRef.current = refreshToken;
  });

  useEffect(() => {
    if (phase !== "live" || !sessionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bound the recovery path. A persistent 401 (e.g. the presence row was
    // reaped, or two tabs share a sessionId and fight over rotate-on-join) must
    // not become an unbounded join+poll stream. Back off exponentially on
    // consecutive auth failures and give up at a ceiling, surfacing a reconnect
    // instead of hammering the API forever.
    let authFailures = 0;
    const MAX_AUTH_FAILURES = 5;
    const MAX_BACKOFF_MS = 30_000;

    const schedule = (delay: number) => {
      if (active) timer = setTimeout(tick, delay);
    };

    const onAuthFailure = async () => {
      authFailures += 1;
      if (authFailures >= MAX_AUTH_FAILURES) {
        // Stop the loop — no reschedule. Surface a TERMINAL notice (persistent,
        // danger-tinted, with a Reload action) rather than a transient toast.
        // showTerminalNotice clears any mid-flight transient toast first so the
        // two can never overlap at the same top-6 z-50 coordinate.
        showTerminalNotice("Session expired. Reload the page to reconnect.");
        return;
      }
      await refreshTokenRef.current();
      schedule(Math.min(POLL_INTERVAL_MS * 2 ** authFailures, MAX_BACKOFF_MS));
    };

    const tick = async () => {
      try {
        const token = tokenRef.current;
        if (!token) {
          // No token yet (or it was cleared); recover before polling.
          await onAuthFailure();
          return;
        }
        const data = await poll(sessionId, token);
        if (!active) return;
        authFailures = 0; // a clean poll clears the backoff
        // Exclude blocked peers from discovery entirely (map dots, the
        // accessible "Nearby signals" list, and the count all derive from this).
        setPeers(filterPeers(data.peers));
        for (const s of data.signals) processSignalRef.current(s);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          // Token rotated/expired → re-mint, back off, give up at the ceiling.
          await onAuthFailure();
          return;
        }
        // Any other error (network blip, 429) retries at the normal cadence
        // without counting against the auth-failure ceiling.
      }
      schedule(POLL_INTERVAL_MS);
    };
    tick();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
    // showTerminalNotice and blocklist.filterPeers are stable hook returns, so
    // listing them is churn-free — the loop still (re)starts only on a
    // phase/session change.
  }, [phase, sessionId, showTerminalNotice, filterPeers]);

  useEffect(() => {
    if (!sessionId || phase !== "live") return;
    const onLeave = () => {
      const token = tokenRef.current;
      if (token) leave(sessionId, token);
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [sessionId, phase]);

  async function handleReady(lat: number, lng: number) {
    setMyLocation({ lat, lng });
    locationRef.current = { lat, lng };
    const { token } = await join(sessionId, lat, lng);
    tokenRef.current = token;
    setPhase("live");
  }

  if (phase === "gate") {
    return <EntryGate onReady={handleReady} />;
  }

  // ChatPanel only mounts once the data channel is open. During the "connecting"
  // handshake, WorldMap stays visible (Origin Story zoom plays) and a "Connecting…"
  // pill shows so the user knows something is happening.
  const inChat = conn.kind === "connected";
  const activePeerId = conn.kind !== "idle" ? conn.peerId : undefined;

  return (
    // tabIndex=-1 + ref so focus can be returned here (not <body>) after the
    // Block→Undo toast is dismissed/timed-out — see useNotice's focus net.
    <main ref={mainRef} tabIndex={-1} className="fixed inset-0 overflow-hidden outline-none">
      <WorldMap
        peers={
          conn.kind === "connecting" || conn.kind === "connected"
            ? peers.filter((p) => p.id === activePeerId)
            : peers
        }
        me={myLocation}
        onPeerClick={requestConnection}
        canConnect={conn.kind === "idle"}
        originPeer={originPeer}
      />

      {/* Z-TIER: status messaging always sits ABOVE modals/panels.
          ConnectionPrompt + VideoPanel occupy z-40; every transient toast and
          the terminal notice ride z-50 so they can never be occluded. Distinct
          top slots keep two simultaneously-possible toasts from stacking on the
          exact same coordinate: transient confirmations + the terminal notice
          own top-6; the "requesting" pill drops to top-20 so a leftover
          confirmation toast and an active request never collide. */}

      {/* Terminal / unrecoverable notice. Persistent — no auto-dismiss —
          with a danger-tinted glass, a warning glyph, and a real focusable
          Reload control. role="alert" so it's announced assertively. Rendered
          first within the z-50 tier and on its own top-6 slot. */}
      {terminalNotice && (
        <div
          role="alert"
          className="animate-pill-in absolute left-1/2 top-6 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-danger/40 bg-danger/15 px-4 py-3 text-sm text-haze-50 shadow-[0_0_28px_-6px_var(--color-danger)] backdrop-blur-xl"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="h-5 w-5 shrink-0 text-danger-400"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          </svg>
          <span className="leading-snug">{terminalNotice}</span>
          <button
            type="button"
            onClick={() => location.reload()}
            className="ml-1 shrink-0 rounded-full bg-danger px-3.5 py-1.5 text-xs font-semibold text-ink-950 transition hover:bg-danger-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 active:scale-95"
          >
            Reload
          </button>
        </div>
      )}

      {/* Transient confirmation toast — PERSISTENT live region.
          The role=status container is ALWAYS mounted (suppressed only while a
          terminalNotice owns the slot); only its inner content swaps. A live
          region that is injected together with its text often fails to announce,
          so keeping the region resident and changing it empty→full makes the
          announcement fire reliably for SR users.

          Politeness varies per-notice: a destructive RESULT (Block/Undo) sets
          notice.assertive, which promotes the region to role=alert +
          aria-live=assertive so it interrupts; routine notices (e.g. "Video
          declined") stay role=status + aria-live=polite. We always render BOTH
          the polite and the assertive region so a content swap inside the right
          one is what fires — toggling a single region's politeness on the same
          node is unreliable.

          Focus: when an ACTION notice mounts, focus moves to its Undo button so
          the 6s safety net is reachable without a blind tab from <body> (see the
          hasAction effect); dismissing/timeout returns focus to <main>. */}
      {!terminalNotice && (
        <>
          {/* Polite region — always resident; carries non-assertive notices. */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {notice && !notice.assertive ? notice.text : ""}
          </div>
          {/* Assertive region — always resident; carries destructive results. */}
          <div
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            className="sr-only"
          >
            {notice && notice.assertive ? notice.text : ""}
          </div>

          {/* The VISIBLE toast. The announcement comes from the resident live
              regions above; to avoid the SAME text appearing twice in the a11y
              tree we hide only the redundant text SPAN below — NOT the whole
              toast. Hiding the whole toast would also hide the Undo button we
              move focus to, stranding focus in an aria-hidden subtree (ghost
              focus). So the wrapper stays exposed and the Undo button remains a
              real, focusable, announced control. Mounted only when there is a
              notice to show. */}
          {notice && (
            <div
              className="animate-pill-in glass-faint absolute left-1/2 top-6 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full py-2 pl-4 pr-2 text-sm text-haze-100"
            >
              {/* Visual-only: the resident live region already announces this. */}
              <span aria-hidden="true" className="leading-snug">
                {notice.text}
              </span>
              {notice.action && (
                <button
                  ref={undoRef}
                  type="button"
                  // The surrounding text span is aria-hidden, so the button
                  // carries its own self-contained name (action + context) for
                  // when focus is moved here on the Block→Undo path.
                  aria-label={`${notice.action.label} — ${notice.text}`}
                  onClick={() => {
                    const act = notice.action!.onAct;
                    dismissNotice();
                    act();
                  }}
                  className="shrink-0 rounded-full bg-signal px-3.5 py-1 text-xs font-bold text-ink-950 shadow-glow-sm transition hover:bg-signal-400 active:scale-95"
                >
                  {notice.action.label}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {conn.kind === "requesting" && (
        <div
          role="status"
          className="animate-pill-in glass absolute left-1/2 top-20 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full py-2 pl-4 pr-2 text-sm text-haze-100"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
          </span>
          <span>Sending signal…</span>
          <button
            onClick={cancelRequest}
            className="rounded-full bg-ink-700/70 px-3 py-1 text-xs font-medium text-haze-200 transition hover:bg-ink-600 active:scale-95"
          >
            Cancel
          </button>
        </div>
      )}

      {conn.kind === "connecting" && (
        <div
          role="status"
          className="animate-pill-in glass absolute left-1/2 top-20 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full py-2 pl-4 pr-2 text-sm text-haze-100"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
          </span>
          <span>Connecting…</span>
        </div>
      )}

      {conn.kind === "incoming" && (
        <ConnectionPrompt
          title="A stranger is reaching out"
          subtitle="Someone nearby wants to connect with you."
          acceptLabel="Connect"
          declineLabel="Ignore"
          onAccept={acceptIncoming}
          onDecline={declineIncoming}
          peerId={conn.peerId}
          variant="connect"
        />
      )}

      {inChat && (
        <ChatPanel
          messages={chat.messages}
          connected={conn.kind === "connected"}
          videoBusy={video !== "none"}
          onSend={chat.sendMessage}
          onStartVideo={startVideoRequest}
          onEnd={endConnection}
          onBlock={blockPeer}
          peerId={activePeerId}
          peerTyping={chat.peerTyping}
          onTyping={chat.sendTyping}
        />
      )}

      {video === "requesting" && (
        <div
          role="status"
          className="animate-pill-in glass-faint absolute bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-full px-4 py-2.5 text-sm text-haze-100"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
          </span>
          Waiting for stranger to accept video…
        </div>
      )}

      {video === "incoming" && (
        <ConnectionPrompt
          title="Start video call?"
          subtitle="The stranger wants to turn on their camera."
          acceptLabel="Accept"
          declineLabel="Decline"
          onAccept={acceptVideo}
          onDecline={declineVideo}
          peerId={activePeerId}
          variant="video"
        />
      )}

      {video === "active" && (
        <VideoPanel
          localStream={localStream}
          remoteStream={remoteStream}
          onEnd={endVideo}
          peerAway={peerAway}
          localAway={localAway}
          isMuted={isMuted}
          onToggleMute={toggleMute}
          isCameraOn={isCameraOn}
          onToggleCamera={toggleCamera}
          peerMuted={peerMuted}
          peerCameraOn={peerCameraOn}
          selectedFilter={selectedFilter}
          onSelectFilter={selectFilter}
        />
      )}

    </main>
  );
}
