import { TokenBucket, createInboundChatBucket } from "@/lib/chatRate";

export type DescType = "offer" | "answer" | "ice";
export type PeerControl =
  | "video-request"
  | "video-accept"
  | "video-decline"
  | "video-end"
  // Phase 4 "Reciprocal Video" presence shield. Sent over the existing data
  // channel via sendControl(). "presence-present" doubles as the periodic
  // heartbeat (fail-closed: a peer is treated as away until one arrives and if
  // they stop arriving); "presence-away" is the explicit instant cut.
  | "presence-present"
  | "presence-away";

export interface TurnCredentialsResponse {
  urls: string[];
  username?: string;
  credential?: string;
  error?: string;
}

interface PeerCallbacks {
  onSignal: (type: DescType, payload: string) => void;
  onChat: (text: string) => void;
  // Delivery Echo. Fired when the peer's client acks a message WE sent — the
  // honest "Delivered" signal. Carries the sender-local message id (echoed back
  // in the {t:"ack", id} frame) so the caller flips the matching outbound
  // message by id, not array position. P2P-only, never touches the server.
  onDelivered: (id: number) => void;
  onControl: (ctrl: PeerControl) => void;
  // Phase 4 typing indicator. Fired when the peer's typing state flips. Rides
  // the existing data channel via a {t:"typing", on} message — fully ephemeral,
  // never stored (consistent with the app's no-persistence privacy model).
  onTyping: (isTyping: boolean) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onChannelOpen: () => void;
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// Fetches short-lived ICE (STUN+TURN) credentials from the coordination API.
// The backend now requires the session id + capability token as query params
// and returns 401 without a valid token; on any failure we fall back to
// STUN-only (Google) so same-network/easy-NAT calls still work.
//
// NOTE: the backend issues TURN credentials with a 600s (10 min) TTL. For
// calls longer than the TTL the relayed candidates expire. A full ICE-restart
// refresh is out of scope for this phase (stakeholder ruling); a long-lived
// active call should re-fetch creds before expiry. TODO(phase-4): refresh ICE
// servers ~30s before the 600s TTL elapses and renegotiate.
export async function buildICEConfig(
  id?: string,
  token?: string,
): Promise<RTCConfiguration> {
  try {
    // Only append id/token when both are present so the credential-less call
    // path (and existing unit tests) hit the bare endpoint unchanged.
    const url =
      id && token
        ? `/api/turn-credentials?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`
        : "/api/turn-credentials";
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.warn(`TURN fetch failed: HTTP ${response.status}, using STUN only`);
      return ICE_CONFIG;
    }

    const data = (await response.json()) as TurnCredentialsResponse;

    if (data.error) {
      console.warn(`TURN error: ${data.error}, using STUN only`);
      return ICE_CONFIG;
    }

    if (!data.urls || !Array.isArray(data.urls) || data.urls.length === 0) {
      console.warn("TURN: missing or empty urls, using STUN only");
      return ICE_CONFIG;
    }

    if (!data.username || !data.credential) {
      console.warn("TURN: missing username or credential, using STUN only");
      return ICE_CONFIG;
    }

    return {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: data.urls,
          username: data.username,
          credential: data.credential,
        },
      ],
    };
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.name === "AbortError" || error.message.includes("aborted")
          ? "timeout"
          : error.message
        : "unknown";
    console.warn(`TURN fetch error: ${reason}, using STUN only`);
    return ICE_CONFIG;
  }
}

export class PeerSession {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  // The stream bound to the caller's LOCAL self-view. Its video track is the
  // ORIGINAL camera track and must NEVER be disabled — the user always sees
  // themselves, even while the outgoing feed is gated.
  private localStream: MediaStream | null = null;
  // The CLONE of the camera video track that is actually sent to the peer.
  // Cloning shares the same camera source but gives an independent .enabled, so
  // gating it blacks the transmitted frames without touching the local preview.
  private sentVideoTrack: MediaStreamTrack | null = null;
  private closed = false;
  private readonly cb: PeerCallbacks;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  // Per-session INBOUND chat flood clamp (render protection, NOT security;
  // see lib/chatRate.ts). A token bucket spent ONLY by incoming chat
  // (t:"msg") frames; ctrl/typing frames never touch it. Built lazily so
  // sessions that never receive chat pay nothing.
  private chatFloodClamp: TokenBucket | null = null;

  constructor(
    initiator: boolean,
    cb: PeerCallbacks,
    iceConfig: RTCConfiguration = ICE_CONFIG,
  ) {
    this.cb = cb;
    this.polite = !initiator;
    this.pc = new RTCPeerConnection(iceConfig);

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.cb.onSignal("ice", JSON.stringify(candidate));
      }
    };

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          this.cb.onSignal("offer", JSON.stringify(this.pc.localDescription));
        }
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.ontrack = ({ streams }) => {
      this.cb.onRemoteStream(streams[0] ?? null);
    };

    this.pc.onconnectionstatechange = () => {
      this.cb.onConnectionState(this.pc.connectionState);
    };

    if (initiator) {
      this.dc = this.pc.createDataChannel("chat");
      this.wireDataChannel(this.dc);
    } else {
      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        this.wireDataChannel(this.dc);
      };
    }
  }

  private wireDataChannel(dc: RTCDataChannel) {
    const handleOpen = () => {
      if (this.closed) return;
      this.cb.onChannelOpen();
    };

    if (dc.readyState === "open") {
      handleOpen();
    } else {
      dc.onopen = handleOpen;
    }

    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.t === "msg" && typeof msg.text === "string") {
          // Type-aware flood clamp: ONLY chat (t:"msg") is rate-limited.
          // Excess chat is dropped silently (onChat simply isn't called) so
          // a runaway sender can't flood the render path. ctrl frames
          // (presence heartbeats + reciprocal-video signalling) and typing
          // frames are dispatched below WITHOUT touching this bucket, so the
          // presence shield can never be starved by chat volume. Unknown
          // future msg.t values also bypass it (forward-compatible).
          //
          // The inbound clamp runs strictly MORE permissive than the sender's
          // own outbound cooldown (createInboundChatBucket adds a small grace),
          // so clock skew between the two peers can never silently drop a
          // message a compliant sender believed was within the limit.
          if (!this.chatFloodClamp)
            this.chatFloodClamp = createInboundChatBucket();
          if (this.chatFloodClamp.tryRemove()) {
            this.cb.onChat(msg.text);
            // Delivery Echo (Story B): ack ONLY after the clamp passed AND the
            // message was actually handed to onChat — i.e. it really reached
            // (and rendered on) this client. A dropped (clamped) message sends
            // NO ack, so it honestly stays at "Sent" on the sender. Acked only
            // when the inbound frame carried an id (older id-less peers get no
            // ack, mirroring the unknown-type bypass — forward/backward compat).
            if (typeof msg.id === "number") {
              this.sendAck(msg.id);
            }
          }
        } else if (msg.t === "ack" && typeof msg.id === "number") {
          // EXEMPT from the flood clamp by design (hard requirement): acks ride
          // their own branch alongside ctrl/typing and never touch the t:"msg"
          // bucket. Clamping acks would falsely strand delivered messages at
          // "Sent". This fires onDelivered with the sender-local id echoed back.
          this.cb.onDelivered(msg.id);
        } else if (msg.t === "ctrl" && typeof msg.ctrl === "string") {
          this.cb.onControl(msg.ctrl as PeerControl);
        } else if (msg.t === "typing" && typeof msg.on === "boolean") {
          this.cb.onTyping(msg.on);
        }
      } catch {}
    };
  }

  async handleSignal(type: DescType, payload: string) {
    if (this.closed) return;
    const data = JSON.parse(payload);

    if (type === "ice") {
      if (!this.pc.remoteDescription) {
        this.pendingCandidates.push(data);
        return;
      }
      try {
        await this.pc.addIceCandidate(data);
      } catch {}
      return;
    }

    const desc = data as RTCSessionDescriptionInit;
    const offerCollision =
      desc.type === "offer" &&
      (this.makingOffer || this.pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    try {
      await this.pc.setRemoteDescription(desc);
    } catch {
      return;
    }

    await this.flushPendingCandidates();
    if (desc.type === "offer") {
      try {
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          this.cb.onSignal("answer", JSON.stringify(this.pc.localDescription));
        }
      } catch {}
    }
  }

  private async flushPendingCandidates() {
    if (this.pendingCandidates.length === 0) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  // Delivery Echo (Story A): the message carries the sender's LOCAL msgId so the
  // peer can echo it back in an ack and we can flip exactly that outbound
  // message to "Delivered" by id. id is always sent by this build; an older
  // peer that ignores it still renders the text fine (text is unchanged).
  sendChat(text: string, id: number) {
    this.safeSend({ t: "msg", text, id });
  }

  // Delivery Echo (Story B): echo the received message's id straight back as a
  // bare ack frame. safeSend no-ops on a closed channel; the receive side keeps
  // this frame OUT of the flood clamp (its own dispatch branch above).
  sendAck(id: number): void {
    this.safeSend({ t: "ack", id });
  }

  sendControl(ctrl: PeerControl) {
    this.safeSend({ t: "ctrl", ctrl });
  }

  // Phase 4 typing indicator. Broadcasts the local typing state to the peer
  // over the existing data channel. safeSend() no-ops if the channel isn't
  // open, so this is safe to call at any point in the session lifecycle.
  sendTyping(on: boolean): void {
    this.safeSend({ t: "typing", on });
  }

  private safeSend(obj: unknown) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(obj));
    }
  }

  // Starts the camera and wires up the clone-and-gate split.
  //
  // localStream keeps the ORIGINAL camera tracks — the caller binds this to the
  // local <video> self-view, and we never disable its video track, so the user
  // always sees a live preview of themselves.
  //
  // The peer connection instead receives a CLONE of the camera video track
  // (track.clone() shares the same camera source but has an independent
  // .enabled). Gating toggles the clone, so the transmitted feed can go black
  // without ever darkening the local preview. Audio is added directly (it is
  // never gated). The clone is associated with localStream on addTrack so the
  // remote ontrack handler still groups video + audio into one stream.
  async startVideo(): Promise<MediaStream> {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      const [videoTrack] = this.localStream.getVideoTracks();
      if (videoTrack) {
        // Send a clone so gating it never affects the original preview track.
        this.sentVideoTrack = videoTrack.clone();
        // Born gated (fail-closed): the clone starts disabled so no clear frame
        // can ever flow before the presence engine confirms mutual presence —
        // we don't rely on React effect ordering for the initial cut.
        this.sentVideoTrack.enabled = false;
        this.pc.addTrack(this.sentVideoTrack, this.localStream);
      }

      // Audio is never gated; send the original track directly.
      for (const track of this.localStream.getAudioTracks()) {
        this.pc.addTrack(track, this.localStream);
      }
    }
    return this.localStream;
  }

  // Gate the OUTGOING video: the protective core of the Phase 4 presence shield.
  // Setting track.enabled = false makes the sender transmit black frames while
  // audio keeps flowing, so no clear video reaches the peer unless both sides
  // are present. This is intentionally the reliable primitive: a CSS/canvas
  // blur cannot run while the local tab is hidden (requestAnimationFrame is
  // throttled/paused in background tabs), whereas track.enabled is enforced by
  // the media pipeline regardless of tab state. Toggling .enabled does NOT
  // require renegotiation.
  //
  // Crucially we gate the SENT CLONE (this.sentVideoTrack), never the original
  // camera track in localStream — so the user's LOCAL self-view stays live the
  // whole time. The clone's black frames still reach the peer. We also iterate
  // the pc video senders (whose track is the clone) for defense in depth, so
  // the gate holds no matter which reference is read. No-op-safe before any
  // video track exists.
  setOutgoingVideoEnabled(enabled: boolean): void {
    if (this.sentVideoTrack) {
      this.sentVideoTrack.enabled = enabled;
    }
    for (const sender of this.pc.getSenders()) {
      if (sender.track && sender.track.kind === "video") {
        sender.track.enabled = enabled;
      }
    }
  }

  stopVideo() {
    if (this.localStream) {
      // Stop the ORIGINAL camera tracks (turns the camera light off).
      for (const track of this.localStream.getTracks()) track.stop();
      this.localStream = null;
    }
    // Stop the SENT clone too — it holds its own handle on the camera source.
    if (this.sentVideoTrack) {
      this.sentVideoTrack.stop();
      this.sentVideoTrack = null;
    }
    for (const sender of this.pc.getSenders()) {
      if (sender.track) {
        try {
          this.pc.removeTrack(sender);
        } catch {}
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopVideo();
    if (this.dc) {
      try {
        this.dc.close();
      } catch {}
    }
    try {
      this.pc.close();
    } catch {}
  }
}
