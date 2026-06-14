"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import EntryGate from "./components/EntryGate";
import WorldMap from "./components/WorldMap";
import ConnectionPrompt from "./components/ConnectionPrompt";
import ChatPanel, { type ChatMessage } from "./components/ChatPanel";
import VideoPanel from "./components/VideoPanel";
import { join, leave, poll, sendSignal, UnauthorizedError } from "@/lib/api";
import { PeerSession, buildICEConfig, type DescType, type PeerControl } from "@/lib/webrtc";
import { POLL_INTERVAL_MS } from "@/lib/presence";
import { type PeerDot, type SignalMsg, type SignalType } from "@/lib/types";
import { callSign } from "@/lib/callsign";
import { filterBlockedPeers, isBlockedRequest } from "@/lib/blocklist";
type Conn =
  | { kind: "idle" }
  | { kind: "requesting"; peerId: string }
  | { kind: "incoming"; peerId: string }
  | { kind: "connecting"; peerId: string }
  | { kind: "connected"; peerId: string };

type VideoState = "none" | "requesting" | "incoming" | "active";

const REQUEST_TIMEOUT_MS = 30_000;

// Auto-dismiss windows for the transient confirmation toast (showNotice).
// A plain toast clears at NOTICE_MS; one carrying an action (e.g. Block's Undo)
// gets NOTICE_ACTION_MS — a longer, calmer window to reach the control.
const NOTICE_MS = 3500;
const NOTICE_ACTION_MS = 6000;

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
  // Transient confirmation toast. Most callers pass plain text; the Block flow
  // attaches an optional `action` (label + handler) so the same single-slot
  // toast can carry an Undo affordance without a second toast system. A nonce
  // re-arms the auto-dismiss timer for the latest notice and lets the action
  // path use a longer window (see showNotice).
  //
  // A11y (M1): the toast lives in a PERSISTENT live region (always-mounted
  // container; only its inner content swaps), so an announcement fires on each
  // empty→full content change rather than racing the region's own mount. The
  // optional `assertive` flag promotes the announcement to assertive/role=alert
  // for the result of a destructive action (Block/Undo) while routine notices
  // (e.g. "Video declined") stay polite.
  type NoticeAction = { label: string; onAct: () => void };
  type Notice = {
    text: string;
    action?: NoticeAction;
    assertive?: boolean;
    nonce: number;
  };
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeNonce = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M1 focus management for the Block→Undo safety net. After blockPeer(),
  // teardown() unmounts ChatPanel and the focused Block button is destroyed,
  // so focus would fall to <body> and the keyboard/SR user would have to
  // blind-tab to find Undo within the 6s window. Instead we move focus to the
  // Undo button when an action notice mounts (undoRef), and return focus to the
  // map/main region (mainRef) on dismiss/timeout/after-Undo so it never rests
  // on a removed node. A ref-flag tracks whether WE moved focus, so we only
  // pull it back when we were the ones who placed it.
  const undoRef = useRef<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const movedFocusForNotice = useRef(false);
  // Terminal (unrecoverable) notice — distinct from the transient confirmation
  // toast: it persists until the user acts (Reload) rather than auto-dismissing.
  // Kept separate so showNotice()'s 3.5s path stays untouched.
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // Phase 4 typing indicator. True while the peer is composing a message.
  // Ephemeral peer-driven UI flag: set straight from the data-channel callback
  // (onTyping), cleared on a real inbound message and on teardown. No ref mirror
  // needed — it is only read in render, never inside an interval or callback.
  const [peerTyping, setPeerTyping] = useState(false);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  // ── Origin Story ──
  // Peer coords set at the moment either party clicks "Connect". Passed to
  // WorldMap so it flies the camera to frame both dots during the handshake.
  // Cleared on teardown so the next connection gets a fresh zoom.
  const [originPeer, setOriginPeer] = useState<{ lat: number; lng: number } | null>(null);

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
  // Phase 4 "Block & Next" — an EPHEMERAL, in-memory blocklist of peer ids the
  // user has refused. Held in a ref ON PURPOSE: it is read synchronously inside
  // the poll tick (to filter discovery) and inside processSignal (to auto-decline
  // inbound requests), and it must NOT survive the tab. No state, no localStorage,
  // no DB — a peer is identified by a per-page-load UUID, so this list dies with
  // the session and a reloaded peer gets a fresh identity. That ceiling is stated
  // honestly in the UI copy (see the Block button title + the toast). The two
  // decisions over this set (discovery filter + auto-decline) live as pure
  // helpers in lib/blocklist.ts so they're unit-testable without the page.
  const blockedRef = useRef<Set<string>>(new Set());
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

  // Show a transient toast. Pass an `action` to attach a single inline button
  // (e.g. Undo) and `assertive` to promote the announcement for a destructive
  // result. Re-arms a single shared timer so a newer notice always wins and an
  // older one can't dismiss it early. Acting on (or being replaced) clears it.
  // Wrapped in useCallback so it's a stable reference: it's read inside the
  // incoming-prompt-expiry effect ([conn]) and we don't want that effect to
  // re-subscribe on every render. It closes only over stable refs + setNotice,
  // so an empty dep list is correct.
  const showNotice = useCallback(
    (
      text: string,
      opts?: { action?: NoticeAction; assertive?: boolean },
    ) => {
      const action = opts?.action;
      const assertive = opts?.assertive;
      const nonce = ++noticeNonce.current;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      setNotice({ text, action, assertive, nonce });
      noticeTimer.current = setTimeout(
        () => {
          // Only clear if no newer notice has superseded this one.
          if (noticeNonce.current === nonce) setNotice(null);
        },
        action ? NOTICE_ACTION_MS : NOTICE_MS,
      );
    },
    [],
  );

  // Return focus to the main/map region — but ONLY if we were the ones who
  // moved it onto the toast (so we never yank focus from wherever the user
  // legitimately put it). Used on dismiss, timeout, and after Undo fires.
  function returnFocusToMain() {
    if (movedFocusForNotice.current) {
      movedFocusForNotice.current = false;
      mainRef.current?.focus();
    }
  }

  function dismissNotice() {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    returnFocusToMain();
    setNotice(null);
  }

  // M1 — when an ACTION notice (the Block→Undo toast) mounts, move focus onto
  // its Undo button so the 6s window is reachable without a blind tab from
  // <body> (ChatPanel having just unmounted). The persistent live region still
  // announces the text; this only places focus. Non-action notices don't grab
  // focus. When the notice clears, return focus to main if we placed it there.
  //
  // Keyed on the action notice's NONCE, not merely "has an action": if a second
  // action toast supersedes a first within the window, hasAction would stay true
  // and the effect would NOT re-run, leaving focus stranded on the prior (now
  // removed) Undo button. The nonce changes per notice, so each new action toast
  // re-runs the focus move onto ITS button. `null` while there's no action.
  const actionNonce = notice?.action ? notice.nonce : null;
  useEffect(() => {
    if (actionNonce !== null) {
      movedFocusForNotice.current = true;
      // rAF so the button is laid out before we focus it.
      const id = requestAnimationFrame(() => undoRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    // The action notice went away (timeout/replacement) without going through
    // dismissNotice — return focus to main if it was ours to return.
    returnFocusToMain();
  }, [actionNonce]);

  function addMessage(mine: boolean, text: string): number {
    // createdAt is a CLIENT-ONLY wall-clock stamp (Date.now(), ms epoch) read
    // solely by ChatPanel's Fade Trails decay. It is NOT sent over the wire,
    // NOT persisted, and does NOT change a message's real lifetime — messages
    // stay in-memory and are cleared on teardown.
    //
    // Delivery Echo: allocate the id BEFORE the setMessages closure so we can
    // return it. The outbound send rides this SAME id on the wire ({t:"msg",
    // id}); the peer echoes it back in an ack and onDelivered flips this exact
    // message to Delivered by id. id is monotonic & session-local, never sent
    // for incoming-tagging purposes beyond this.
    const id = msgId.current++;
    setMessages((prev) => [
      ...prev,
      { id, mine, text, createdAt: Date.now() },
    ]);
    return id;
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
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
    peerRef.current?.close();
    peerRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
    resetPresence();
    setPeerTyping(false);
    setMessages([]);
    setOriginPeer(null);
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
          onChat: (text) => {
            // A real message means they have stopped typing.
            setPeerTyping(false);
            addMessage(false, text);
          },
          onDelivered: (id) => {
            // Delivery Echo (Story C): flip exactly the matching OUTBOUND
            // message to delivered, matched BY ID (not array position). Pure
            // functional update keyed on id makes it idempotent — a duplicate,
            // stale, or foreign ack maps to an already-delivered or non-matching
            // message and returns prev unchanged, so no re-render / re-animate.
            // Order-independent: rapid-fire acks each land on their own id.
            setMessages((prev) => {
              let changed = false;
              const next = prev.map((m) => {
                if (m.id === id && m.mine && !m.delivered) {
                  changed = true;
                  return { ...m, delivered: true };
                }
                return m;
              });
              return changed ? next : prev;
            });
          },
          onControl: (ctrl) => handleControl(ctrl),
          onTyping: (on) => setPeerTyping(on),
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
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
    const peerId = connRef.current.peerId;
    const incomingPeer = peers.find((p) => p.id === peerId);
    if (incomingPeer) setOriginPeer({ lat: incomingPeer.lat, lng: incomingPeer.lng });
    void startPeer(peerId, false);
    void emitSignal(peerId, "accept");
    setConn({ kind: "connecting", peerId });
  }

  function declineIncoming() {
    if (connRef.current.kind !== "incoming") return;
    if (incomingTimer.current) clearTimeout(incomingTimer.current);
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

  // Phase 4 — refuse the current peer for the rest of this session, then return
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
  //      the 6s safety net is reachable for keyboard/SR users (M1).
  function blockPeer() {
    const c = connRef.current;
    if (c.kind !== "connecting" && c.kind !== "connected") return;
    const peerId = c.peerId;
    blockedRef.current.add(peerId);
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
          blockedRef.current.delete(peerId);
          showNotice(`Unblocked ${sign}`);
        },
      },
    });
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
        // Phase 4 — a request from a blocked peer is silently auto-declined and
        // NO prompt is shown. We emit the SAME "decline" a busy/ignored request
        // produces, so it is indistinguishable from a normal decline — no
        // "you are blocked" signal is ever leaked to the peer. Checked first so
        // we never fall through to the busy path and double-emit decline.
        if (isBlockedRequest(sig.fromId, blockedRef.current)) {
          void emitSignal(sig.fromId, "decline");
          break;
        }
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
        setConn({ kind: "idle" });
        showNotice("That request expired.");
      }
    }, REQUEST_TIMEOUT_MS - 2_000);
    return () => {
      if (incomingTimer.current) {
        clearTimeout(incomingTimer.current);
        incomingTimer.current = null;
      }
    };
    // showNotice is a stable useCallback, so listing it here is churn-free.
  }, [conn, showNotice]);

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
        // Stop the loop — no reschedule. Surface a TERMINAL notice (persistent,
        // danger-tinted, with a Reload action) rather than a transient toast.
        // FIX: the terminal notice takes precedence over any transient toast that
        // may be mid-flight (both share the top-6 z-50 slot). Clear the transient
        // notice so the two can never overlap at the same coordinate.
        setNotice(null);
        setTerminalNotice("Session expired. Reload the page to reconnect.");
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
        // Phase 4 — exclude blocked peers from discovery entirely (map dots, the
        // accessible "Nearby signals" list, and the count all derive from this).
        setPeers(filterBlockedPeers(data.peers, blockedRef.current));
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

  // ChatPanel only mounts once the data channel is open. During the "connecting"
  // handshake, WorldMap stays visible (Origin Story zoom plays) and a "Connecting…"
  // pill shows so the user knows something is happening.
  const inChat = conn.kind === "connected";
  const activePeerId = conn.kind !== "idle" ? conn.peerId : undefined;

  return (
    // tabIndex=-1 + ref so focus can be returned here (not <body>) after the
    // Block→Undo toast is dismissed/timed-out — see returnFocusToMain (M1).
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

      {/* Z-TIER (M6): status messaging always sits ABOVE modals/panels.
          ConnectionPrompt + VideoPanel occupy z-40; every transient toast and
          the terminal notice ride z-50 so they can never be occluded. Distinct
          top slots keep two simultaneously-possible toasts from stacking on the
          exact same coordinate: transient confirmations + the terminal notice
          own top-6; the "requesting" pill drops to top-20 so a leftover
          confirmation toast and an active request never collide. */}

      {/* Terminal / unrecoverable notice (M8). Persistent — no auto-dismiss —
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

      {/* Transient confirmation toast — PERSISTENT live region (M1).
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
          messages={messages}
          connected={conn.kind === "connected"}
          videoBusy={video !== "none"}
          onSend={(text) => {
            // Delivery Echo: append locally first so we own the id, then send
            // that SAME id on the wire. The peer's ack echoes it back and flips
            // this message to Delivered (onDelivered, by id). sendChat returns
            // whether the frame actually went out over an open channel — only
            // then do we mark the message "Sent" (honest: a no-op'd send on a
            // closed channel claims nothing).
            const id = addMessage(true, text);
            const sent = peerRef.current?.sendChat(text, id) ?? false;
            if (sent) {
              setMessages((prev) =>
                prev.map((m) => (m.id === id ? { ...m, sent: true } : m)),
              );
            }
          }}
          onStartVideo={startVideoRequest}
          onEnd={endConnection}
          onBlock={blockPeer}
          peerId={activePeerId}
          peerTyping={peerTyping}
          onTyping={(on: boolean) => peerRef.current?.sendTyping(on)}
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
        />
      )}

    </main>
  );
}
