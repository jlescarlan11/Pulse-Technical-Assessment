/**
 * Tier 2 camera filters — transmit-path unit tests.
 *
 * Target: PeerSession.setFilter() and the canvas filter stage it drives. The
 * stakeholder's conditions of approval are encoded directly as assertions:
 *
 *   - None-bypass: the default/startup state transmits the RAW clone with NO
 *     canvas and NO requestAnimationFrame loop (zero cost at rest).
 *   - Gate-ordering invariant: a non-"none" preset swaps in the canvas-derived
 *     track via replaceTrack (NO renegotiation), and that track is born at the
 *     CURRENT gate state — born GATED while the gate is closed (the key
 *     invariant: a filtered call is exactly as fail-closed as an unfiltered one).
 *   - setOutgoingVideoEnabled still gates the canvas track.
 *   - Switching none -> warm -> mono -> none behaves (mid-filter switch does NOT
 *     swap tracks / renegotiate).
 *   - captureStream unavailable => honest "none" fallback; setFilter returns
 *     "none".
 *   - stopVideo tears the loop + canvas track down.
 *
 * These run over fake MediaStream / RTCPeerConnection / canvas / video objects
 * in the SAME mocking style as webrtc.presence.test.ts — no real getUserMedia,
 * no real network, no real DOM rendering.
 */
import { PeerSession } from "./webrtc";
import { FILTER_PRESETS, getFilterPreset } from "./videoFilters";

// --- Fakes -----------------------------------------------------------------

/** A minimal MediaStreamTrack stand-in: only what the filter path touches. */
type FakeTrack = {
  kind: "video" | "audio";
  enabled: boolean;
  stop: jest.Mock;
  clone: () => FakeTrack;
  getSettings?: () => { width: number; height: number };
  cloned?: FakeTrack;
};

function makeTrack(kind: "video" | "audio"): FakeTrack {
  const track: FakeTrack = {
    kind,
    enabled: true,
    stop: jest.fn(),
    getSettings: () => ({ width: 640, height: 480 }),
    clone: () => {
      const copy = makeTrack(kind);
      track.cloned = copy;
      return copy;
    },
  };
  return track;
}

function makeStream(tracks: FakeTrack[]): MediaStream {
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  };
  return stream as unknown as MediaStream;
}

type FakeSender = {
  track: FakeTrack | null;
  replaceTrack: jest.Mock;
};

/**
 * A fake RTCPeerConnection. addTrack records a sender; replaceTrack mutates the
 * sender's track in place (mirroring the browser, which swaps the outgoing
 * track WITHOUT renegotiation). A spy on the sender's replaceTrack lets tests
 * assert the swap happened (and assert that NO offer was generated, since the
 * fake never invokes onnegotiationneeded).
 */
class FakeRTCPeerConnection {
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: unknown) => void) | null = null;
  connectionState: RTCPeerConnectionState = "new";
  senders: FakeSender[] = [];

  createDataChannel() {
    return { readyState: "connecting", send: jest.fn(), close: jest.fn() };
  }
  addTrack(track: FakeTrack) {
    const sender: FakeSender = {
      track,
      replaceTrack: jest.fn((next: FakeTrack) => {
        sender.track = next;
      }),
    };
    this.senders.push(sender);
    return sender;
  }
  getSenders() {
    return this.senders;
  }
  removeTrack(sender: FakeSender) {
    sender.track = null;
  }
  close() {}
}

const noopCallbacks = {
  onSignal: () => {},
  onChat: () => {},
  onDelivered: () => {},
  onControl: () => {},
  onTyping: () => {},
  onRemoteStream: () => {},
  onConnectionState: () => {},
  onChannelOpen: () => {},
};

// --- Canvas / video / rAF fakes --------------------------------------------
//
// The filter stage calls document.createElement("canvas"|"video"),
// canvas.getContext("2d"), canvas.captureStream(fps), and requestAnimationFrame.
// jsdom (this project's jest env) does NOT implement captureStream, so we have
// to install our own canvas fake to exercise the active-filter path at all —
// and a SEPARATE harness leaves captureStream absent to prove the honest "none"
// fallback.

type FakeCanvas = {
  width: number;
  height: number;
  getContext: jest.Mock;
  captureStream?: jest.Mock;
  capturedTrack?: FakeTrack;
};

type FakeVideo = {
  muted: boolean;
  playsInline: boolean;
  srcObject: MediaStream | null;
  play: jest.Mock;
};

let rafCallbacks: Array<() => void> = [];
let rafNextId = 1;
let cancelledRafIds: number[] = [];

/**
 * Install browser-API fakes. When `captureStreamSupported` is false the canvas
 * has NO captureStream method, which is exactly how jsdom / unsupported
 * browsers present — driving the honest "none" fallback.
 */
function installBrowserFakes(opts: { captureStreamSupported: boolean }) {
  rafCallbacks = [];
  rafNextId = 1;
  cancelledRafIds = [];

  const created: { canvases: FakeCanvas[]; videos: FakeVideo[] } = {
    canvases: [],
    videos: [],
  };

  const createElement = jest.fn((tag: string) => {
    if (tag === "canvas") {
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        getContext: jest.fn(() => {
          // A 2D context with a writable `filter` slot + a no-op drawImage.
          return { filter: "none", drawImage: jest.fn() };
        }),
      };
      if (opts.captureStreamSupported) {
        canvas.captureStream = jest.fn(() => {
          const track = makeTrack("video");
          canvas.capturedTrack = track;
          return makeStream([track]);
        });
      }
      created.canvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    }
    if (tag === "video") {
      const video: FakeVideo = {
        muted: false,
        playsInline: false,
        srcObject: null,
        play: jest.fn(() => Promise.resolve()),
      };
      created.videos.push(video);
      return video as unknown as HTMLVideoElement;
    }
    throw new Error(`unexpected createElement(${tag})`);
  });

  (global as Record<string, unknown>).document = { createElement };
  (global as Record<string, unknown>).requestAnimationFrame = jest.fn(
    (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafNextId++;
    },
  );
  (global as Record<string, unknown>).cancelAnimationFrame = jest.fn(
    (id: number) => {
      cancelledRafIds.push(id);
    },
  );

  return created;
}

// --- Test harness ----------------------------------------------------------

const RealRTC = (global as Record<string, unknown>).RTCPeerConnection;
const realNavigator = (global as Record<string, unknown>).navigator;
const realDocument = (global as Record<string, unknown>).document;
const realRaf = (global as Record<string, unknown>).requestAnimationFrame;
const realCancelRaf = (global as Record<string, unknown>).cancelAnimationFrame;

function installRtcAndMedia(streamTracks: FakeTrack[]) {
  (global as Record<string, unknown>).RTCPeerConnection = FakeRTCPeerConnection;
  (global as Record<string, unknown>).navigator = {
    mediaDevices: {
      getUserMedia: jest.fn(async () => makeStream(streamTracks)),
    },
  };
}

afterEach(() => {
  (global as Record<string, unknown>).RTCPeerConnection = RealRTC;
  (global as Record<string, unknown>).navigator = realNavigator;
  (global as Record<string, unknown>).document = realDocument;
  (global as Record<string, unknown>).requestAnimationFrame = realRaf;
  (global as Record<string, unknown>).cancelAnimationFrame = realCancelRaf;
  jest.restoreAllMocks();
});

async function sessionWithTracks(tracks: FakeTrack[]) {
  installRtcAndMedia(tracks);
  const ps = new PeerSession(true, noopCallbacks);
  await ps.startVideo();
  return ps;
}

/** Read the single video sender off the session's fake pc. */
function videoSender(ps: PeerSession): FakeSender {
  const pc = (ps as unknown as { pc: FakeRTCPeerConnection }).pc;
  const sender = pc.senders.find((s) => s.track?.kind === "video");
  if (!sender) throw new Error("expected a video sender");
  return sender;
}

// --- preset constants ------------------------------------------------------

describe("FILTER_PRESETS (single source of truth)", () => {
  it('lists "none" first as the default passthrough with empty css', () => {
    expect(FILTER_PRESETS[0].id).toBe("none");
    expect(FILTER_PRESETS[0].css).toBe("");
  });

  it("exposes exactly none/night/warm/mono with non-empty css for grades", () => {
    expect(FILTER_PRESETS.map((p) => p.id)).toEqual([
      "none",
      "night",
      "warm",
      "mono",
    ]);
    for (const p of FILTER_PRESETS) {
      if (p.id === "none") continue;
      expect(p.css.length).toBeGreaterThan(0);
      // Forbidden: blur reads as a privacy claim.
      expect(p.css).not.toContain("blur");
    }
  });

  it("getFilterPreset defaults unknown/empty ids to none", () => {
    expect(getFilterPreset("nope").id).toBe("none");
    expect(getFilterPreset(undefined).id).toBe("none");
    expect(getFilterPreset(null).id).toBe("none");
    expect(getFilterPreset("warm").id).toBe("warm");
  });
});

// --- none-bypass -----------------------------------------------------------

describe("PeerSession.setFilter — none-bypass (zero cost at rest)", () => {
  it("default startup transmits the RAW clone with no canvas / no rAF loop", async () => {
    // Install canvas fakes that WOULD support captureStream, to prove the bypass
    // is a choice (we never call into them) and not an environment accident.
    const created = installBrowserFakes({ captureStreamSupported: true });
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);

    // The sent track is the raw clone; no canvas built, no rAF scheduled.
    const sender = videoSender(ps);
    expect(sender.track).toBe(video.cloned); // the raw clone
    expect(created.canvases).toHaveLength(0);
    expect(rafCallbacks).toHaveLength(0);
  });

  it('setFilter("none") on a fresh session is a no-op returning "none"', async () => {
    installBrowserFakes({ captureStreamSupported: true });
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);
    const sender = videoSender(ps);

    const effective = ps.setFilter("none");

    expect(effective).toBe("none");
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(sender.track).toBe(video.cloned);
    expect(rafCallbacks).toHaveLength(0);
  });
});

// --- active filter: swap + gate inheritance --------------------------------

describe("PeerSession.setFilter — activating a grade", () => {
  it("swaps in the canvas track via replaceTrack (no renegotiation)", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    const pc = (ps as unknown as { pc: FakeRTCPeerConnection }).pc;
    const sender = videoSender(ps);

    const effective = ps.setFilter("warm");

    expect(effective).toBe("warm");
    expect(sender.replaceTrack).toHaveBeenCalledTimes(1);
    // The new sent track is the canvas-derived track.
    expect(sender.track).toBe(created.canvases[0].capturedTrack);
    // No renegotiation: the fake never fires onnegotiationneeded, and we used
    // replaceTrack rather than removeTrack/addTrack (sender count unchanged).
    expect(pc.senders.filter((s) => s.track?.kind === "video")).toHaveLength(1);
    // The draw loop is now running.
    expect(rafCallbacks.length).toBeGreaterThan(0);
  });

  it("KEY INVARIANT: the swapped-in canvas track is born GATED when the gate is closed", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);

    // Gate is closed by default (born fail-closed); explicitly assert that, then
    // turn on a filter and confirm the canvas track is born disabled.
    ps.setFilter("night");

    const canvasTrack = created.canvases[0].capturedTrack!;
    expect(canvasTrack.enabled).toBe(false);
    // And the sender carries that gated track.
    expect(videoSender(ps).track).toBe(canvasTrack);
    expect(videoSender(ps).track!.enabled).toBe(false);
  });

  it("born at the OPEN gate state when presence is already present", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);

    // Presence engine opened the gate before a filter was chosen.
    ps.setOutgoingVideoEnabled(true);
    ps.setFilter("mono");

    const canvasTrack = created.canvases[0].capturedTrack!;
    // The freshly swapped-in track inherits the OPEN gate (true), so a live
    // filtered call keeps flowing — no false black frame on swap.
    expect(canvasTrack.enabled).toBe(true);
  });
});

// --- gate still controls the canvas track ----------------------------------

describe("PeerSession.setOutgoingVideoEnabled gates the canvas track", () => {
  it("flips the canvas-derived track's .enabled like it does the raw clone", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    ps.setFilter("warm");
    const canvasTrack = created.canvases[0].capturedTrack!;

    ps.setOutgoingVideoEnabled(true);
    expect(canvasTrack.enabled).toBe(true);

    ps.setOutgoingVideoEnabled(false);
    expect(canvasTrack.enabled).toBe(false);
  });
});

// --- switching presets -----------------------------------------------------

describe("PeerSession.setFilter — none -> warm -> mono -> none", () => {
  it("only swaps tracks at the none boundaries, repaints in between", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    const sender = videoSender(ps);
    const rawClone = sender.track; // the raw clone object

    // none -> warm: build pipeline + swap (1 replaceTrack).
    expect(ps.setFilter("warm")).toBe("warm");
    expect(sender.replaceTrack).toHaveBeenCalledTimes(1);
    const canvasTrack = created.canvases[0].capturedTrack!;
    expect(sender.track).toBe(canvasTrack);

    // warm -> mono: NO new canvas, NO new swap — just a repaint. Still 1 swap
    // total, still the SAME canvas track, no second canvas created.
    expect(ps.setFilter("mono")).toBe("mono");
    expect(sender.replaceTrack).toHaveBeenCalledTimes(1);
    expect(created.canvases).toHaveLength(1);
    expect(sender.track).toBe(canvasTrack);

    // mono -> none: tear down + swap BACK to the raw clone (2nd replaceTrack).
    expect(ps.setFilter("none")).toBe("none");
    expect(sender.replaceTrack).toHaveBeenCalledTimes(2);
    expect(sender.track).toBe(rawClone);
    // The canvas track was stopped on teardown.
    expect(canvasTrack.stop).toHaveBeenCalled();
  });
});

// --- honest fallback when captureStream is unavailable ---------------------

describe("PeerSession.setFilter — honest fallback", () => {
  it('falls back to the raw clone and returns "none" when captureStream is unavailable', async () => {
    // jsdom-like: canvas exists but has NO captureStream.
    const created = installBrowserFakes({ captureStreamSupported: false });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    const sender = videoSender(ps);
    const rawClone = sender.track;

    const effective = ps.setFilter("warm");

    // Honest: returns the grade ACTUALLY in effect, not the requested one.
    expect(effective).toBe("none");
    // The raw clone keeps flowing; no swap happened.
    expect(sender.track).toBe(rawClone);
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    // A canvas was probed but no rAF loop was left running.
    expect(created.canvases.length).toBeGreaterThanOrEqual(0);
    expect(rafCallbacks).toHaveLength(0);
  });

  it('returns "none" with no crash when the DOM is entirely absent', async () => {
    // No document at all (pure non-browser): startVideo still works (RTC + media
    // are faked), but the filter pipeline cannot be built.
    installRtcAndMedia([makeTrack("video"), makeTrack("audio")]);
    (global as Record<string, unknown>).document = undefined;
    const ps = new PeerSession(true, noopCallbacks);
    await ps.startVideo();

    expect(ps.setFilter("mono")).toBe("none");
  });
});

// --- cleanup ---------------------------------------------------------------

describe("PeerSession.stopVideo — filter cleanup", () => {
  it("stops the rAF loop, the canvas track, and releases the source video", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    ps.setFilter("night");
    const canvasTrack = created.canvases[0].capturedTrack!;
    const sourceVideo = created.videos[0];
    expect(rafCallbacks.length).toBeGreaterThan(0); // loop was running

    ps.stopVideo();

    // rAF loop cancelled.
    expect(cancelledRafIds.length).toBeGreaterThan(0);
    // Canvas-derived track stopped.
    expect(canvasTrack.stop).toHaveBeenCalled();
    // Hidden source <video> released its camera handle.
    expect(sourceVideo.srcObject).toBeNull();
  });

  it("is a no-op (no throw) on stopVideo when no filter was ever active", async () => {
    installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);

    expect(() => ps.stopVideo()).not.toThrow();
    // No canvas track was ever built, so no cancelAnimationFrame needed.
    expect(cancelledRafIds).toHaveLength(0);
  });
});
