export type DescType = "offer" | "answer" | "ice";
export type PeerControl =
  | "video-request"
  | "video-accept"
  | "video-decline"
  | "video-end";

export interface TurnCredentialsResponse {
  urls: string[];
  username?: string;
  credential?: string;
  error?: string;
}

interface PeerCallbacks {
  onSignal: (type: DescType, payload: string) => void;
  onChat: (text: string) => void;
  onControl: (ctrl: PeerControl) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onChannelOpen: () => void;
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export async function buildICEConfig(): Promise<RTCConfiguration> {
  console.log("[DEBUG] buildICEConfig: starting TURN credentials fetch");
  try {
    const response = await fetch("/api/turn-credentials", {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    console.log(`[DEBUG] TURN fetch response status: ${response.status}`);

    if (!response.ok) {
      console.warn(`TURN fetch failed: HTTP ${response.status}`);
      console.log("[DEBUG] falling back to STUN only");
      return ICE_CONFIG;
    }

    const data = (await response.json()) as TurnCredentialsResponse;
    console.log("[DEBUG] TURN response data:", data);

    if (data.error) {
      console.warn(`TURN error: ${data.error}`);
      console.log("[DEBUG] falling back to STUN only");
      return ICE_CONFIG;
    }

    if (!data.urls || !Array.isArray(data.urls) || data.urls.length === 0) {
      console.warn("TURN: missing or empty urls");
      console.log("[DEBUG] falling back to STUN only");
      return ICE_CONFIG;
    }

    if (!data.username || !data.credential) {
      console.warn("TURN: missing username or credential");
      console.log("[DEBUG] falling back to STUN only");
      return ICE_CONFIG;
    }

    const config = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: data.urls,
          username: data.username,
          credential: data.credential,
        },
      ],
    };
    console.log("[DEBUG] buildICEConfig: successfully configured STUN + TURN", config);
    return config;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError" || error.message.includes("aborted")) {
        console.warn("TURN fetch timeout");
      } else {
        console.warn(`TURN fetch error: ${error.message}`);
      }
    } else {
      console.warn("TURN fetch error: unknown");
    }
    console.log("[DEBUG] buildICEConfig: falling back to STUN only");
    return ICE_CONFIG;
  }
}

export class PeerSession {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  private localStream: MediaStream | null = null;
  private closed = false;
  private readonly cb: PeerCallbacks;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    initiator: boolean,
    cb: PeerCallbacks,
    iceConfig: RTCConfiguration = ICE_CONFIG,
  ) {
    console.log("[DEBUG] PeerSession constructor: initiator=", initiator, "iceServers count=", iceConfig.iceServers?.length);
    this.cb = cb;
    this.polite = !initiator;
    this.pc = new RTCPeerConnection(iceConfig);
    console.log("[DEBUG] RTCPeerConnection created, connectionState=", this.pc.connectionState);

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        console.log("[DEBUG] ICE candidate generated:", candidate.candidate?.substring(0, 80));
        this.cb.onSignal("ice", JSON.stringify(candidate));
      } else {
        console.log("[DEBUG] ICE candidate gathering completed (null candidate)");
      }
    };

    this.pc.onnegotiationneeded = async () => {
      console.log("[DEBUG] onnegotiationneeded triggered");
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          console.log("[DEBUG] sending", this.pc.localDescription.type, "offer");
          this.cb.onSignal("offer", JSON.stringify(this.pc.localDescription));
        }
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.ontrack = ({ streams }) => {
      console.log("[DEBUG] ontrack: received remote stream");
      this.cb.onRemoteStream(streams[0] ?? null);
    };

    this.pc.onconnectionstatechange = () => {
      const newState = this.pc.connectionState;
      console.log("[DEBUG] connectionState changed to:", newState);
      console.log("[DEBUG] iceConnectionState:", this.pc.iceConnectionState, "signalingState:", this.pc.signalingState);
      this.cb.onConnectionState(newState);
    };

    this.pc.onicegatheringstatechange = () => {
      console.log("[DEBUG] iceGatheringState:", this.pc.iceGatheringState);
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
          this.cb.onChat(msg.text);
        } else if (msg.t === "ctrl" && typeof msg.ctrl === "string") {
          this.cb.onControl(msg.ctrl as PeerControl);
        }
      } catch {}
    };
  }

  async handleSignal(type: DescType, payload: string) {
    if (this.closed) {
      console.log("[DEBUG] handleSignal called but peer is closed, ignoring");
      return;
    }
    console.log("[DEBUG] handleSignal:", type);
    const data = JSON.parse(payload);

    if (type === "ice") {
      console.log("[DEBUG] handling ICE candidate, remoteDescription exists:", !!this.pc.remoteDescription);
      if (!this.pc.remoteDescription) {
        this.pendingCandidates.push(data);
        console.log("[DEBUG] queued ICE candidate (pending candidates: " + this.pendingCandidates.length + ")");
        return;
      }
      try {
        console.log("[DEBUG] adding ICE candidate");
        await this.pc.addIceCandidate(data);
      } catch (e) {
        console.log("[DEBUG] failed to add ICE candidate:", e instanceof Error ? e.message : "unknown error");
      }
      return;
    }

    const desc = data as RTCSessionDescriptionInit;
    console.log("[DEBUG] handling SDP", desc.type, "- signalingState: " + this.pc.signalingState + " makingOffer: " + this.makingOffer);
    const offerCollision =
      desc.type === "offer" &&
      (this.makingOffer || this.pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) {
      console.log("[DEBUG] ignoring offer due to collision (polite=" + this.polite + ")");
      return;
    }

    try {
      await this.pc.setRemoteDescription(desc);
      console.log("[DEBUG] setRemoteDescription succeeded");
    } catch (e) {
      console.log("[DEBUG] setRemoteDescription failed:", e instanceof Error ? e.message : "unknown error");
      return;
    }

    await this.flushPendingCandidates();
    if (desc.type === "offer") {
      try {
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          console.log("[DEBUG] sending answer");
          this.cb.onSignal("answer", JSON.stringify(this.pc.localDescription));
        }
      } catch (e) {
        console.log("[DEBUG] failed to create answer:", e instanceof Error ? e.message : "unknown error");
      }
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

  sendChat(text: string) {
    this.safeSend({ t: "msg", text });
  }

  sendControl(ctrl: PeerControl) {
    this.safeSend({ t: "ctrl", ctrl });
  }

  private safeSend(obj: unknown) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(obj));
    }
  }

  async startVideo(): Promise<MediaStream> {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }
    }
    return this.localStream;
  }

  stopVideo() {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      for (const sender of this.pc.getSenders()) {
        if (sender.track) {
          try {
            this.pc.removeTrack(sender);
          } catch {}
        }
      }
      this.localStream = null;
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
