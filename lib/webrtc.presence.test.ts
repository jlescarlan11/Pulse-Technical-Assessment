/**
 * Phase 4 "Reciprocal Video" — protective core unit tests.
 *
 * Target: PeerSession.setOutgoingVideoEnabled(). This is the security-critical
 * primitive of the presence shield: when either peer is away the outgoing video
 * track is disabled at the media-pipeline level (track.enabled = false) so no
 * clear video reaches the stranger. These tests assert that contract directly
 * against a PeerSession built over fake MediaStream / RTCPeerConnection objects
 * — no real getUserMedia, no real network, no timers.
 */
import { PeerSession } from "./webrtc";

// --- Fakes -----------------------------------------------------------------

/** A minimal MediaStreamTrack stand-in: only what the gate touches. */
type FakeTrack = {
  kind: "video" | "audio";
  enabled: boolean;
  stop: jest.Mock;
};

function makeTrack(kind: "video" | "audio"): FakeTrack {
  return { kind, enabled: true, stop: jest.fn() };
}

/** A MediaStream stand-in exposing the getter methods PeerSession calls. */
function makeStream(tracks: FakeTrack[]): MediaStream {
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  };
  return stream as unknown as MediaStream;
}

/**
 * A fake RTCPeerConnection. The PeerSession constructor wires several handlers
 * and (for the initiator) calls createDataChannel; addTrack records a sender so
 * getSenders() mirrors the real browser behaviour the gate relies on.
 */
class FakeRTCPeerConnection {
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: unknown) => void) | null = null;
  connectionState: RTCPeerConnectionState = "new";
  private senders: { track: FakeTrack | null }[] = [];

  createDataChannel() {
    return { readyState: "connecting", send: jest.fn(), close: jest.fn() };
  }
  addTrack(track: FakeTrack) {
    const sender = { track };
    this.senders.push(sender);
    return sender;
  }
  getSenders() {
    return this.senders;
  }
  removeTrack(sender: { track: FakeTrack | null }) {
    sender.track = null;
  }
  close() {}
}

const noopCallbacks = {
  onSignal: () => {},
  onChat: () => {},
  onControl: () => {},
  onRemoteStream: () => {},
  onConnectionState: () => {},
  onChannelOpen: () => {},
};

// --- Test harness ----------------------------------------------------------

const RealRTC = (global as Record<string, unknown>).RTCPeerConnection;
const realNavigator = (global as Record<string, unknown>).navigator;

let getUserMediaMock: jest.Mock;

function installFakes(streamTracks: FakeTrack[] | null) {
  (global as Record<string, unknown>).RTCPeerConnection = FakeRTCPeerConnection;
  getUserMediaMock = jest.fn(async () =>
    streamTracks ? makeStream(streamTracks) : makeStream([]),
  );
  (global as Record<string, unknown>).navigator = {
    mediaDevices: { getUserMedia: getUserMediaMock },
  };
}

afterEach(() => {
  (global as Record<string, unknown>).RTCPeerConnection = RealRTC;
  (global as Record<string, unknown>).navigator = realNavigator;
  jest.restoreAllMocks();
});

/** Build a PeerSession whose localStream + pc senders carry the given tracks. */
async function sessionWithTracks(tracks: FakeTrack[]) {
  installFakes(tracks);
  const ps = new PeerSession(true, noopCallbacks);
  await ps.startVideo(); // populates localStream + addTrack() senders
  return ps;
}

// --- Tests -----------------------------------------------------------------

describe("PeerSession.setOutgoingVideoEnabled (presence shield core)", () => {
  it("disables every outgoing video track when set to false", async () => {
    const video = makeTrack("video");
    const audio = makeTrack("audio");
    const ps = await sessionWithTracks([video, audio]);

    ps.setOutgoingVideoEnabled(false);

    expect(video.enabled).toBe(false);
  });

  it("leaves audio flowing while video is gated (audio is not disabled)", async () => {
    const video = makeTrack("video");
    const audio = makeTrack("audio");
    const ps = await sessionWithTracks([video, audio]);

    ps.setOutgoingVideoEnabled(false);

    // The shield blacks video but must keep audio connected.
    expect(audio.enabled).toBe(true);
  });

  it("re-enables the outgoing video track when set back to true", async () => {
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);

    ps.setOutgoingVideoEnabled(false);
    expect(video.enabled).toBe(false);

    ps.setOutgoingVideoEnabled(true);
    expect(video.enabled).toBe(true);
  });

  it("gates ALL video tracks, not just the first", async () => {
    const v1 = makeTrack("video");
    const v2 = makeTrack("video");
    const ps = await sessionWithTracks([v1, v2, makeTrack("audio")]);

    ps.setOutgoingVideoEnabled(false);

    expect(v1.enabled).toBe(false);
    expect(v2.enabled).toBe(false);
  });

  it("is a no-op (no throw) when no video track exists yet", () => {
    // Fresh session, startVideo never called -> localStream is null and there
    // are no senders. The gate must not throw in this pre-video window.
    installFakes(null);
    const ps = new PeerSession(true, noopCallbacks);

    expect(() => ps.setOutgoingVideoEnabled(false)).not.toThrow();
    expect(() => ps.setOutgoingVideoEnabled(true)).not.toThrow();
  });

  it("toggles deterministically across repeated away/present cycles", async () => {
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);

    for (let i = 0; i < 5; i++) {
      ps.setOutgoingVideoEnabled(false);
      expect(video.enabled).toBe(false);
      ps.setOutgoingVideoEnabled(true);
      expect(video.enabled).toBe(true);
    }
  });

  it("keeps the gate closed across the pc senders too (defense in depth)", async () => {
    // The implementation flips both the localStream track and the matching
    // RTCRtpSender.track. With our fake pc, addTrack stored the same track
    // object reference, so disabling once must hold on the sender's view.
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);

    ps.setOutgoingVideoEnabled(false);

    // The sender's track is the same object; it must read disabled.
    expect(video.enabled).toBe(false);
  });
});
