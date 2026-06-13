"use client";

import { useEffect, useRef, useState } from "react";
import EntryGate from "./components/EntryGate";
import WorldMap from "./components/WorldMap";
import ConnectionPrompt from "./components/ConnectionPrompt";
import ChatPanel, { type ChatMessage } from "./components/ChatPanel";
import VideoPanel from "./components/VideoPanel";
import { join, leave, poll, sendSignal, UnauthorizedError } from "@/lib/api";
import { PeerSession, buildICEConfig, type DescType, type PeerControl } from "@/lib/webrtc";
import { POLL_INTERVAL_MS } from "@/lib/presence";
import { type PeerDot, type SignalMsg, type SignalType } from "@/lib/types";

type Conn =
  | { kind: "idle" }
  | { kind: "requesting"; peerId: string }
  | { kind: "incoming"; peerId: string }
  | { kind: "connecting"; peerId: string }
  | { kind: "connected"; peerId: string };

type VideoState = "none" | "requesting" | "incoming" | "active";

const REQUEST_TIMEOUT_MS = 30_000;

// ── Reciprocal Video (mutual-presence) tuning ──
const AWAY_DEBOUNCE_MS = 500; // tab must stay hidden this long before cutting
const RESUME_DELAY_MS = 150; // settle before re-showing once mutually present
const HEARTBEAT_INTERVAL_MS = 2_000; // presence ping cadence while present
const HEARTBEAT_TIMEOUT_MS = 4_000; // no ping within this ⇒ peer treated as away

export default function Home() {
  const [phase, setPhase] = useState<"gate" | "live">("gate");
  const [sessionId] = useState(() => crypto.randomUUID());
  // Per-session capability token issued by /api/join. Held in a ref (not state)
  // because it must be readable synchronously inside the poll interval, every
  // signal sender, and the pagehide/beforeunload leave handler — none of which
  // should re-run when it rotates. Mirrors sessionId's session-long lifetime.
  const tokenRef = useRef<string | null>(null);
  const [peers, setPeers] = useState<PeerDot[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  const [conn, _setConn] = useState<Conn>({ kind: "idle" });
  const connRef = useRef<Conn>(conn);
  const setConn = (c: Conn) => {
    connRef.current = c;
    _setConn(c);
  };

  const [video, _setVideo] = useState<VideoState>("none");
  const videoRef = useRef<VideoState>(video);
  const setVideo = (v: VideoState) => {
    videoRef.current = v;
    _setVideo(v);
  };

  // ── Reciprocal Video presence state ──
  // localAway: this tab has stepped away (hidden/pagehide). peerAway: the
  // stranger has — fail-closed (assume away until the first heartbeat arrives).
  // Mirrored into refs so the heartbeat interval and the data-channel control
  // handler read the latest value without re-subscribing.
  const [localAway, _setLocalAway] = useState(false);
  const localAwayRef = useRef(false);
  const setLocalAway = (v: boolean) => {
    localAwayRef.current = v;
    _setLocalAway(v);
  };

  const [peerAway, _setPeerAway] = useState(true);
  const peerAwayRef = useRef(true);
  const setPeerAway = (v: boolean) => {
    peerAwayRef.current = v;
    _setPeerAway(v);
  };

  const lastPeerPresentAt = useRef(0); // 0 = never heard from the peer yet
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const peerRef = useRef<PeerSession | null>(null);
  const msgId = useRef(0);
  const requestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  function showNotice(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 3500);
  }

  function addMessage(mine: boolean, text: string) {
    setMessages((prev) => [...prev, { id: msgId.current++, mine, text }]);
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
    const mutuallyPresent = !localAwayRef.current && !peerAwayRef.current;
    if (!mutuallyPresent) {
      ps.setOutgoingVideoEnabled(false);
    } else {
      resumeTimer.current = setTimeout(() => {
        resumeTimer.current = null;
        if (!localAwayRef.current && !peerAwayRef.current) {
          peerRef.current?.setOutgoingVideoEnabled(true);
        }
      }, RESUME_DELAY_MS);
    }
  }

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

  function teardown(message?: string) {
    if (requestTimer.current) clearTimeout(requestTimer.current);
    peerRef.current?.close();
    peerRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
    resetPresence();
    setMessages([]);
    setConn({ kind: "idle" });
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
          onChat: (text) => addMessage(false, text),
          onControl: (ctrl) => handleControl(ctrl),
          onRemoteStream: (stream) => setRemoteStream(stream),
          onConnectionState: (state) => {
            if (state === "failed") {
              teardown("Connection failed (network).");
            }
          },
          onChannelOpen: () => {
            setConn({ kind: "connected", peerId });
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
        if (videoRef.current === "none") setVideo("incoming");
        break;
      case "video-accept":
        if (videoRef.current === "requesting" && ps) {
          ps.startVideo()
            .then((stream) => {
              setLocalStream(stream);
              setVideo("active");
            })
            .catch(() => {
              setVideo("none");
              ps.sendControl("video-end");
              showNotice("Camera unavailable.");
            });
        }
        break;
      case "video-decline":
        if (videoRef.current === "requesting") {
          setVideo("none");
          showNotice("Video declined.");
        }
        break;
      case "video-end":
        ps?.stopVideo();
        setLocalStream(null);
        setRemoteStream(null);
        setVideo("none");
        resetPresence();
        break;
      case "presence-present":
        // The stranger's tab is active again (also the periodic heartbeat).
        if (videoRef.current === "active") {
          lastPeerPresentAt.current = Date.now();
          if (peerAwayRef.current) setPeerAway(false);
          applyVideoGateRef.current();
        }
        break;
      case "presence-away":
        // The stranger switched away — cut our outgoing feed immediately.
        if (videoRef.current === "active") {
          if (!peerAwayRef.current) setPeerAway(true);
          applyVideoGateRef.current();
        }
        break;
    }
  }

  function requestConnection(peerId: string) {
    if (connRef.current.kind !== "idle") return;
    setConn({ kind: "requesting", peerId });
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
    const peerId = connRef.current.peerId;
    void startPeer(peerId, false);
    void emitSignal(peerId, "accept");
    setConn({ kind: "connecting", peerId });
  }

  function declineIncoming() {
    if (connRef.current.kind !== "incoming") return;
    void emitSignal(connRef.current.peerId, "decline");
    setConn({ kind: "idle" });
  }

  function endConnection() {
    const c = connRef.current;
    if (c.kind === "connecting" || c.kind === "connected") {
      void emitSignal(c.peerId, "end");
    }
    teardown();
  }

  function startVideoRequest() {
    if (videoRef.current !== "none" || !peerRef.current) return;
    setVideo("requesting");
    peerRef.current.sendControl("video-request");
  }

  function acceptVideo() {
    const ps = peerRef.current;
    if (!ps) return;
    ps.startVideo()
      .then((stream) => {
        setLocalStream(stream);
        ps.sendControl("video-accept");
        setVideo("active");
      })
      .catch(() => {
        ps.sendControl("video-decline");
        setVideo("none");
        showNotice("Camera unavailable.");
      });
  }

  function declineVideo() {
    peerRef.current?.sendControl("video-decline");
    setVideo("none");
  }

  function endVideo() {
    const ps = peerRef.current;
    ps?.stopVideo();
    ps?.sendControl("video-end");
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
    resetPresence();
  }

  function processSignal(sig: SignalMsg) {
    switch (sig.type) {
      case "request": {
        if (connRef.current.kind === "idle") {
          setConn({ kind: "incoming", peerId: sig.fromId });
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
          setConn({ kind: "connecting", peerId: sig.fromId });
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
          if (c.kind === "incoming") setConn({ kind: "idle" });
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

  // applyVideoGate is recreated each render; read it through a ref inside the
  // heartbeat interval and the data-channel control handler so effect deps stay
  // honest and the interval isn't torn down on every render.
  const applyVideoGateRef = useRef(applyVideoGate);
  useEffect(() => {
    applyVideoGateRef.current = applyVideoGate;
  });

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
        // Stop the loop — no reschedule.
        setNotice("Session expired. Reload the page to reconnect.");
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
        setPeers(data.peers);
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
  }, [phase, sessionId]);

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

  // ── Reciprocal Video: mutual-presence privacy engine ──────────────────────
  // While a video call is active, clear video is transmitted only while BOTH
  // tabs are present. Either side switching away (tab hidden / pagehide) cuts
  // the OUTGOING video at the source, so a present user can never watch or
  // record a clear feed of an absent stranger. Audio is untouched. Presence is
  // exchanged as data-channel heartbeats: a "presence-present" ping every
  // HEARTBEAT_INTERVAL_MS while present, an explicit "presence-away" on going
  // hidden, plus a fail-closed staleness check (no ping within
  // HEARTBEAT_TIMEOUT_MS ⇒ peer treated as away) so a dropped channel can't leak
  // a clear feed. Detection is tab visibility only — NOT gaze.
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
  }, [video]);

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

  const inChat = conn.kind === "connecting" || conn.kind === "connected";
  const activePeerId = conn.kind !== "idle" ? conn.peerId : undefined;

  return (
    <main className="fixed inset-0 overflow-hidden">
      <WorldMap
        peers={peers}
        me={myLocation}
        onPeerClick={requestConnection}
        canConnect={conn.kind === "idle"}
      />

      {notice && (
        <div
          role="status"
          className="animate-pill-in glass-faint absolute left-1/2 top-6 z-30 -translate-x-1/2 rounded-full px-4 py-2.5 text-sm text-haze-100"
        >
          {notice}
        </div>
      )}

      {conn.kind === "requesting" && (
        <div
          role="status"
          className="animate-pill-in glass absolute left-1/2 top-6 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full py-2 pl-4 pr-2 text-sm text-haze-100"
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
          messages={messages}
          connected={conn.kind === "connected"}
          videoBusy={video !== "none"}
          onSend={(text) => {
            peerRef.current?.sendChat(text);
            addMessage(true, text);
          }}
          onStartVideo={startVideoRequest}
          onEnd={endConnection}
          peerId={activePeerId}
        />
      )}

      {video === "requesting" && (
        <div
          role="status"
          className="animate-pill-in glass-faint absolute bottom-24 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2.5 rounded-full px-4 py-2.5 text-sm text-haze-100"
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
        />
      )}
    </main>
  );
}
