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

  function teardown(message?: string) {
    if (requestTimer.current) clearTimeout(requestTimer.current);
    peerRef.current?.close();
    peerRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
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

  return (
    <main className="fixed inset-0 overflow-hidden">
      <WorldMap
        peers={peers}
        me={myLocation}
        onPeerClick={requestConnection}
        canConnect={conn.kind === "idle"}
      />

      {notice && (
        <div className="absolute left-1/2 top-20 z-30 -translate-x-1/2 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          {notice}
        </div>
      )}

      {conn.kind === "requesting" && (
        <div className="absolute left-1/2 top-20 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          <span>Requesting connection…</span>
          <button
            onClick={cancelRequest}
            className="rounded-full bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600"
          >
            Cancel
          </button>
        </div>
      )}

      {conn.kind === "incoming" && (
        <ConnectionPrompt
          title="A stranger wants to connect"
          acceptLabel="Accept"
          declineLabel="Decline"
          onAccept={acceptIncoming}
          onDecline={declineIncoming}
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
        />
      )}

      {video === "requesting" && (
        <div className="absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          Waiting for stranger to accept video…
        </div>
      )}

      {video === "incoming" && (
        <ConnectionPrompt
          title="Start video call?"
          subtitle="The stranger wants to turn on video."
          acceptLabel="Accept"
          declineLabel="Decline"
          onAccept={acceptVideo}
          onDecline={declineVideo}
        />
      )}

      {video === "active" && (
        <VideoPanel
          localStream={localStream}
          remoteStream={remoteStream}
          onEnd={endVideo}
        />
      )}
    </main>
  );
}
