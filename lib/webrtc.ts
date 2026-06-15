import { TokenBucket, createInboundChatBucket } from "@/lib/chatRate";
import {
  type FilterPresetId,
  getFilterPreset,
  DEFAULT_FILTER_ID,
} from "@/lib/videoFilters";

export type DescType = "offer" | "answer" | "ice";
export type PeerControl =
  | "video-request"
  | "video-accept"
  | "video-decline"
  | "video-end"
  // Presence shield. Sent over the existing data
  // channel via sendControl(). "presence-present" doubles as the periodic
  // heartbeat (fail-closed: a peer is treated as away until one arrives and if
  // they stop arriving); "presence-away" is the explicit instant cut.
  | "presence-present"
  | "presence-away"
  // "Mute & Camera Controls". Sent over data channel via sendControl()
  // to signal user-initiated mute/unmute and manual camera on/off (distinct
  // from presence-gating). "audio-mute/unmute" gates outgoing audio tracks;
  // "video-manual-off/on" gates outgoing video independently of presence.
  | "audio-mute"
  | "audio-unmute"
  | "video-manual-off"
  | "video-manual-on";

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
  // Typing indicator. Fired when the peer's typing state flips. Rides
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

// Frame rate for the canvas filter capture stream. Bounded ON PURPOSE: a
// filtered call drives a per-frame draw loop + captureStream, so we cap the
// capture (and therefore the per-frame CPU and the encoder's input rate) to
// keep a filtered call's cost predictable. 24fps reads as smooth video while
// leaving headroom on modest hardware. Only ever paid when a non-"none"
// preset is active — "none" never builds the canvas pipeline at all.
const FILTER_CAPTURE_FPS = 24;

// Fetches short-lived ICE (STUN+TURN) credentials from the coordination API.
// The backend now requires the session id + capability token as query params
// and returns 401 without a valid token; on any failure we fall back to
// STUN-only (Google) so same-network/easy-NAT calls still work.
//
// NOTE: the backend issues TURN credentials with a 600s (10 min) TTL. For
// calls longer than the TTL the relayed candidates expire. A full ICE-restart
// refresh is out of scope (stakeholder ruling); a long-lived active call
// should re-fetch creds before expiry. A future refresh would re-fetch ICE
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

  // --- Camera filter (Tier 2 cosmetic color-grade) state ------------------
  //
  // The filter is COSMETIC ONLY. Privacy is owned by the .enabled gate
  // (setOutgoingVideoEnabled), NEVER by the filter: the rAF draw loop is
  // throttled/paused in background tabs, whereas .enabled is enforced by the
  // media pipeline regardless of tab state. By the time a tab is hidden the
  // gate has already cut the feed via .enabled, so a stalled draw loop can
  // never leak a clear frame.
  //
  // None-bypass: when activeFilterId === "none" (the default and common case)
  // NONE of the fields below are populated — no canvas, no <video>, no loop —
  // and the raw clone is transmitted exactly as it was before this feature.
  // The canvas pipeline only comes into existence when a non-"none" preset is
  // selected, and is fully torn down again on stopVideo().
  private activeFilterId: FilterPresetId = DEFAULT_FILTER_ID;
  // The raw cloned camera track — what we transmit when no filter is active,
  // and the source we fall back to. Kept distinct from sentVideoTrack because
  // sentVideoTrack always points at whatever is CURRENTLY sent (raw clone OR
  // the canvas-derived track), and the gate reads sentVideoTrack.
  private rawClone: MediaStreamTrack | null = null;
  // The canvas filter pipeline pieces — all null while on "none".
  private filterCanvas: HTMLCanvasElement | null = null;
  private filterSourceVideo: HTMLVideoElement | null = null;
  private filterStream: MediaStream | null = null;
  private filterTrack: MediaStreamTrack | null = null;
  private filterRafId: number | null = null;
  // The CSS filter string the draw loop currently paints with. Switching
  // between two non-"none" presets only mutates THIS string — no track swap,
  // no renegotiation.
  private filterCss = "";
  // The current gate state, mirrored here so a freshly swapped-in sent track
  // can be born at the right .enabled BEFORE it goes live. Fail-closed
  // default (false): a filtered call is exactly as gated as an unfiltered one.
  private outgoingVideoEnabled = false;

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
            // Number.isInteger rejects NaN/Infinity/floats — ids are always the
            // sender's small monotonic integer counter, so a non-integer id is a
            // malformed/hostile frame and gets no ack.
            if (Number.isInteger(msg.id)) {
              this.sendAck(msg.id);
            }
          }
        } else if (msg.t === "ack" && Number.isInteger(msg.id)) {
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
  // Returns whether the frame actually went out (channel open). The caller uses
  // this to mark the message "Sent" honestly — a no-op'd send on a closed
  // channel returns false and is never shown as Sent.
  sendChat(text: string, id: number): boolean {
    return this.safeSend({ t: "msg", text, id });
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

  // Typing indicator. Broadcasts the local typing state to the peer
  // over the existing data channel. safeSend() no-ops if the channel isn't
  // open, so this is safe to call at any point in the session lifecycle.
  sendTyping(on: boolean): void {
    this.safeSend({ t: "typing", on });
  }

  private safeSend(obj: unknown): boolean {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(obj));
      return true;
    }
    return false;
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
        // We hold this raw clone in its own field (rawClone) because
        // sentVideoTrack tracks whatever is CURRENTLY sent — that is the raw
        // clone now, but becomes the canvas-derived track once a filter is on.
        this.rawClone = videoTrack.clone();
        this.sentVideoTrack = this.rawClone;
        // Born gated (fail-closed): the clone starts disabled so no clear frame
        // can ever flow before the presence engine confirms mutual presence —
        // we don't rely on React effect ordering for the initial cut. This is
        // also the source of truth for outgoingVideoEnabled (already false).
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

  // Gate the OUTGOING video: the protective core of the presence shield.
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
    // Remember the gate state so a track we swap in LATER (when a filter turns
    // on/off) can be born at this exact .enabled before it goes live — see
    // swapSentTrack(). This keeps a filtered call exactly as fail-closed as an
    // unfiltered one: no clear frame can escape during a track swap.
    this.outgoingVideoEnabled = enabled;
    if (this.sentVideoTrack) {
      this.sentVideoTrack.enabled = enabled;
    }
    for (const sender of this.pc.getSenders()) {
      if (sender.track && sender.track.kind === "video") {
        sender.track.enabled = enabled;
      }
    }
  }

  setOutgoingAudioEnabled(enabled: boolean): void {
    for (const sender of this.pc.getSenders()) {
      if (sender.track && sender.track.kind === "audio") {
        sender.track.enabled = enabled;
      }
    }
  }

  // Select the Tier 2 cosmetic color-grade applied to the TRANSMITTED video.
  //
  // Honest return value: this ALWAYS returns the preset id actually in effect,
  // not the one requested. If we cannot build the canvas pipeline (captureStream
  // missing, getContext unavailable, anything throws) we fall back to "none" and
  // return "none" so the caller can sync the UI to the truth rather than show a
  // filter the peer is not receiving.
  //
  // None-bypass (zero cost at rest): selecting "none" tears the canvas pipeline
  // down (if any) and transmits the raw clone EXACTLY as the pre-filter code did
  // — no canvas, no requestAnimationFrame, no per-frame draw. The default
  // startup state is "none", so a call that never touches a filter pays nothing.
  //
  // Switching between two non-"none" presets does NOT swap tracks or
  // renegotiate: it only changes the css string the existing draw loop paints
  // with (the canvas-derived track stays the live sent track).
  //
  // IMPORTANT: the filter is COSMETIC. Privacy is owned by the .enabled gate
  // (setOutgoingVideoEnabled), never by the filter. Any track we swap in is born
  // at the current gate state via swapSentTrack(), so a filtered call is exactly
  // as fail-closed as an unfiltered one.
  setFilter(presetId: string): FilterPresetId {
    const preset = getFilterPreset(presetId); // unknown ids => "none"

    // No video yet: just record the intent. startVideo()/the next setFilter will
    // honor it, and there is nothing to swap. Report the requested grade since
    // no pipeline could have failed.
    if (!this.rawClone) {
      this.activeFilterId = preset.id;
      this.filterCss = preset.css;
      return this.activeFilterId;
    }

    // -> "none": drop any pipeline and go back to transmitting the raw clone.
    if (preset.id === "none") {
      if (this.activeFilterId !== "none") {
        this.teardownFilterPipeline();
        this.swapSentTrack(this.rawClone);
      }
      this.activeFilterId = "none";
      this.filterCss = "";
      return "none";
    }

    // -> non-"none" while ALREADY filtered: just repaint with the new css. No
    // track swap, no renegotiation (hard requirement d).
    if (this.activeFilterId !== "none" && this.filterTrack) {
      this.activeFilterId = preset.id;
      this.filterCss = preset.css;
      return this.activeFilterId;
    }

    // -> non-"none" from "none": build the canvas pipeline and swap the
    // canvas-derived track in. On ANY failure, fall back to the raw clone and
    // report "none" (honest fallback, hard requirement c).
    try {
      const built = this.buildFilterPipeline();
      if (!built) {
        // Unsupported environment (jsdom / older browser): degrade to "none"
        // rather than crash. The raw clone keeps flowing.
        this.teardownFilterPipeline();
        this.activeFilterId = "none";
        this.filterCss = "";
        return "none";
      }
      this.filterCss = preset.css;
      this.swapSentTrack(built);
      this.activeFilterId = preset.id;
      return this.activeFilterId;
    } catch {
      // Building the pipeline threw — tear down whatever partial state exists and
      // fall back to the honest "none" so we never strand a half-built loop.
      this.teardownFilterPipeline();
      this.swapSentTrack(this.rawClone);
      this.activeFilterId = "none";
      this.filterCss = "";
      return "none";
    }
  }

  // Swap the CURRENTLY transmitted video track for `next` WITHOUT renegotiation
  // (replaceTrack only — never remove/add). Crucially `next.enabled` is set to
  // the stored gate state FIRST, before/as it goes live, so no clear frame can
  // escape during the swap: a swapped-in track is exactly as gated as the one it
  // replaces. We also keep this.sentVideoTrack pointed at `next` so the existing
  // setOutgoingVideoEnabled first branch stays correct.
  private swapSentTrack(next: MediaStreamTrack): void {
    // Born at the current gate state (fail-closed default false). Do this BEFORE
    // replaceTrack so the track is already gated the instant it is live.
    next.enabled = this.outgoingVideoEnabled;
    for (const sender of this.pc.getSenders()) {
      if (sender.track && sender.track.kind === "video") {
        sender.replaceTrack(next);
      }
    }
    this.sentVideoTrack = next;
  }

  // Build the canvas filter stage. Returns the canvas-derived video track, or
  // null if the environment lacks the required browser APIs (jsdom / older
  // browsers) — the caller treats null as the honest "none" fallback.
  //
  // The source is a hidden <video> fed the EXISTING localStream (the original
  // camera) — we never open a second getUserMedia. Each animation frame we draw
  // that video into a canvas with ctx.filter set to the active css, and a
  // captureStream(fps) of that canvas is what we transmit.
  //
  // COSMETIC, not protective: the rAF loop is throttled/paused in background
  // tabs, but by then the .enabled gate has already cut the feed — the gate, not
  // this loop, is the privacy authority.
  private buildFilterPipeline(): MediaStreamTrack | null {
    if (
      typeof document === "undefined" ||
      typeof document.createElement !== "function" ||
      !this.localStream
    ) {
      return null;
    }

    const canvas = document.createElement("canvas");
    // captureStream may be entirely absent (jsdom, very old browsers).
    if (typeof canvas.captureStream !== "function") return null;
    const ctx = canvas.getContext("2d");
    // ctx may be null, and ctx.filter is itself a newer API — both => fall back.
    if (!ctx || !("filter" in ctx)) return null;

    const sourceVideo = document.createElement("video");
    sourceVideo.muted = true;
    sourceVideo.playsInline = true;
    sourceVideo.srcObject = this.localStream;
    // play() can reject (autoplay policy); muted+inline should allow it, and a
    // rejected promise is non-fatal — the draw loop simply paints whatever the
    // element currently has. Swallow with context-free .catch (no error to act
    // on; the loop self-heals once frames arrive).
    void sourceVideo.play?.().catch(() => {});

    const settings = this.localStream.getVideoTracks()[0]?.getSettings?.();
    const width = settings?.width ?? 640;
    const height = settings?.height ?? 480;
    canvas.width = width;
    canvas.height = height;

    const stream = canvas.captureStream(FILTER_CAPTURE_FPS);
    const [track] = stream.getVideoTracks();
    if (!track) return null;

    this.filterCanvas = canvas;
    this.filterSourceVideo = sourceVideo;
    this.filterStream = stream;
    this.filterTrack = track;

    const draw = () => {
      // The loop self-cancels if teardown nulled the pieces out.
      if (!this.filterCanvas || !this.filterSourceVideo) return;
      try {
        ctx.filter = this.filterCss || "none";
        ctx.drawImage(this.filterSourceVideo, 0, 0, canvas.width, canvas.height);
      } catch {
        // A transient draw error (e.g. video not yet ready) must not kill the
        // loop — skip this frame and try again next tick.
      }
      this.filterRafId = requestAnimationFrame(draw);
    };
    // Prefer rAF; fall back to a timer if rAF is unavailable so the canvas still
    // updates. requestAnimationFrame returns a number id we cancel on teardown.
    if (typeof requestAnimationFrame === "function") {
      this.filterRafId = requestAnimationFrame(draw);
    } else {
      // No rAF (non-browser): a single draw seeds the captured frame; without a
      // loop the grade is static, which is an acceptable degraded mode.
      draw();
    }

    return track;
  }

  // Stop the draw loop and release the canvas pipeline. Safe to call when no
  // pipeline exists (all fields already null) — that is the "none" common case.
  private teardownFilterPipeline(): void {
    if (this.filterRafId !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.filterRafId);
      }
      this.filterRafId = null;
    }
    if (this.filterTrack) {
      this.filterTrack.stop();
      this.filterTrack = null;
    }
    if (this.filterStream) {
      for (const t of this.filterStream.getTracks()) t.stop();
      this.filterStream = null;
    }
    if (this.filterSourceVideo) {
      // Release the camera handle held by the hidden source element.
      this.filterSourceVideo.srcObject = null;
      this.filterSourceVideo = null;
    }
    this.filterCanvas = null;
  }

  stopVideo() {
    // Tear down the canvas filter stage FIRST: stop the rAF/draw loop, stop
    // the canvas-derived track + its stream, and release the hidden source
    // <video> (srcObject = null) so no animation loop or camera handle is left
    // orphaned after the call ends. No-op when on "none" (nothing was built).
    this.teardownFilterPipeline();
    this.activeFilterId = "none";
    this.filterCss = "";

    if (this.localStream) {
      // Stop the ORIGINAL camera tracks (turns the camera light off).
      for (const track of this.localStream.getTracks()) track.stop();
      this.localStream = null;
    }
    // Stop the SENT clone too — it holds its own handle on the camera source.
    // On "none" sentVideoTrack IS rawClone (same object); on a filtered call
    // sentVideoTrack is the canvas track (already stopped in teardown above).
    // Stop rawClone explicitly so the camera-source clone is always released,
    // and only stop sentVideoTrack separately when it is a DIFFERENT object —
    // never stop the same track twice.
    if (this.sentVideoTrack && this.sentVideoTrack !== this.rawClone) {
      this.sentVideoTrack.stop();
    }
    this.sentVideoTrack = null;
    if (this.rawClone) {
      this.rawClone.stop();
      this.rawClone = null;
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
