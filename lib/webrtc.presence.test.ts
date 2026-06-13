/**
 * Phase 4 "Reciprocal Video" — protective core unit tests.
 *
 * Target: PeerSession.setOutgoingVideoEnabled(). This is the security-critical
 * primitive of the presence shield: when either peer is away the outgoing video
 * is gated at the media-pipeline level (track.enabled = false) so no clear video
 * reaches the stranger.
 *
 * The shield uses a clone-and-gate split: localStream keeps the ORIGINAL camera
 * track (bound to the local self-view, never disabled), while the peer
 * connection sends a CLONE whose .enabled is toggled. So the user always sees a
 * live preview of themselves, but the peer still receives black frames when
 * gated. These tests assert that contract directly against a PeerSession built
 * over fake MediaStream / RTCPeerConnection objects — no real getUserMedia, no
 * real network, no timers.
 */
import { PeerSession } from "./webrtc";

// --- Fakes -----------------------------------------------------------------

/** A minimal MediaStreamTrack stand-in: only what the gate touches. */
type FakeTrack = {
  kind: "video" | "audio";
  enabled: boolean;
  stop: jest.Mock;
  // clone() must return an INDEPENDENT track (its own .enabled) that still
  // mirrors the real browser contract of sharing the same camera source.
  clone: () => FakeTrack;
  // Back-reference to the clone produced by clone(), so a test can inspect the
  // SENT track separately from the original it was cloned from.
  cloned?: FakeTrack;
};

function makeTrack(kind: "video" | "audio"): FakeTrack {
  const track: FakeTrack = {
    kind,
    enabled: true,
    stop: jest.fn(),
    clone: () => {
      const copy = makeTrack(kind);
      track.cloned = copy;
      return copy;
    },
  };
  return track;
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
  await ps.startVideo(); // populates localStream + sends a cloned video track
  return ps;
}

/** The SENT video clone is what the gate toggles; resolve it via the original. */
function sentClone(originalVideo: FakeTrack): FakeTrack {
  if (!originalVideo.cloned) {
    throw new Error("expected startVideo to have cloned the video track");
  }
  return originalVideo.cloned;
}

// --- Tests -----------------------------------------------------------------

describe("PeerSession.setOutgoingVideoEnabled (presence shield core)", () => {
  it("disables the SENT (cloned) video track when set to false", async () => {
    const video = makeTrack("video");
    const audio = makeTrack("audio");
    const ps = await sessionWithTracks([video, audio]);

    ps.setOutgoingVideoEnabled(false);

    // The peer receives black frames: the transmitted clone is disabled.
    expect(sentClone(video).enabled).toBe(false);
  });

  it("keeps the LOCAL preview track live even after gating (never disabled)", async () => {
    const video = makeTrack("video");
    const audio = makeTrack("audio");
    const ps = await sessionWithTracks([video, audio]);

    ps.setOutgoingVideoEnabled(false);

    // The ORIGINAL camera track in localStream stays enabled so the user
    // always sees themselves in the self-view, even while the feed is gated.
    expect(video.enabled).toBe(true);
    // ...and it is a distinct object from the gated clone.
    expect(sentClone(video)).not.toBe(video);
  });

  it("leaves audio flowing while video is gated (audio is not disabled)", async () => {
    const video = makeTrack("video");
    const audio = makeTrack("audio");
    const ps = await sessionWithTracks([video, audio]);

    ps.setOutgoingVideoEnabled(false);

    // The shield blacks video but must keep audio connected.
    expect(audio.enabled).toBe(true);
    // Audio is added directly (not cloned), so it was never cloned.
    expect(audio.cloned).toBeUndefined();
  });

  it("re-enables the outgoing (cloned) video track when set back to true", async () => {
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);

    ps.setOutgoingVideoEnabled(false);
    expect(sentClone(video).enabled).toBe(false);
    expect(video.enabled).toBe(true); // preview stayed live throughout

    ps.setOutgoingVideoEnabled(true);
    expect(sentClone(video).enabled).toBe(true);
    expect(video.enabled).toBe(true);
  });

  it("is a no-op (no throw) when no video track exists yet", () => {
    // Fresh session, startVideo never called -> localStream is null, no clone
    // and no senders. The gate must not throw in this pre-video window.
    installFakes(null);
    const ps = new PeerSession(true, noopCallbacks);

    expect(() => ps.setOutgoingVideoEnabled(false)).not.toThrow();
    expect(() => ps.setOutgoingVideoEnabled(true)).not.toThrow();
  });

  it("toggles deterministically across repeated away/present cycles", async () => {
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);
    const clone = sentClone(video);

    for (let i = 0; i < 5; i++) {
      ps.setOutgoingVideoEnabled(false);
      expect(clone.enabled).toBe(false);
      expect(video.enabled).toBe(true); // preview never flickers off
      ps.setOutgoingVideoEnabled(true);
      expect(clone.enabled).toBe(true);
      expect(video.enabled).toBe(true);
    }
  });

  it("keeps the gate closed across the pc senders too (defense in depth)", async () => {
    // The implementation flips this.sentVideoTrack and iterates the pc video
    // senders. With our fake pc, addTrack stored the clone object reference, so
    // the sender's video track must read disabled after gating.
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);

    ps.setOutgoingVideoEnabled(false);

    expect(sentClone(video).enabled).toBe(false);
  });

  it("stopVideo stops BOTH the original camera track and the sent clone", async () => {
    const video = makeTrack("video");
    const audio = makeTrack("audio");
    const ps = await sessionWithTracks([video, audio]);
    const clone = sentClone(video);

    ps.stopVideo();

    // Original camera tracks stopped (camera light off) ...
    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(audio.stop).toHaveBeenCalledTimes(1);
    // ... and the sent clone is stopped too (it holds its own camera handle).
    expect(clone.stop).toHaveBeenCalledTimes(1);
  });
});
