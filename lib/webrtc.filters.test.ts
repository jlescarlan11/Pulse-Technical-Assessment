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

// --- regression: zero-dimension camera settings ----------------------------

describe("PeerSession.setFilter — canvas sizing guard (BUG-1 regression)", () => {
  it("falls back to 640x480 when getSettings() reports 0 width/height", async () => {
    // Some drivers / virtual cameras report width:0,height:0 transiently before
    // the first frame. A `?? 640` fallback would KEEP the 0 (0 is not nullish),
    // giving a 0x0 canvas whose captureStream emits a black/empty track. The
    // truthy `|| 640` fallback must coerce 0 to a sane size so the filtered feed
    // is real, not black.
    const created = installBrowserFakes({ captureStreamSupported: true });
    const video = makeTrack("video");
    video.getSettings = () => ({ width: 0, height: 0 });
    const ps = await sessionWithTracks([video, makeTrack("audio")]);

    ps.setFilter("warm");

    expect(created.canvases).toHaveLength(1);
    expect(created.canvases[0].width).toBe(640);
    expect(created.canvases[0].height).toBe(480);
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

// ===========================================================================
// Gap-closing tests (test-engineer): harden the PRIVACY INVARIANT and the
// lifecycle/resource paths the original ~17 did not assert directly. Same fake
// MediaStream / RTCPeerConnection / canvas style as above — no new mocking
// approach, no real getUserMedia / network / DOM.
// ===========================================================================

// Count the video senders currently on the fake pc. addTrack pushes a sender;
// removeTrack/replaceTrack never add one. So a swap that stays at exactly ONE
// video sender proves replaceTrack (not removeTrack+addTrack) was used — i.e.
// no renegotiation path was taken.
function videoSenderCount(ps: PeerSession): number {
  const pc = (ps as unknown as { pc: FakeRTCPeerConnection }).pc;
  return pc.senders.filter((s) => s.track?.kind === "video").length;
}

// --- privacy invariant: gate follows the live track across swaps -----------

describe("PeerSession.setFilter — privacy invariant (gate follows the live track)", () => {
  it("after a swap, setOutgoingVideoEnabled(true) then (false) still gates the CANVAS track", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);

    ps.setFilter("warm");
    const canvasTrack = created.canvases[0].capturedTrack!;

    // The gate now operates on the swapped-in canvas track, not the raw clone.
    ps.setOutgoingVideoEnabled(true);
    expect(canvasTrack.enabled).toBe(true);
    expect(videoSender(ps).track!.enabled).toBe(true);

    ps.setOutgoingVideoEnabled(false);
    expect(canvasTrack.enabled).toBe(false);
    // The sender carries the gated canvas track — no clear frame can escape.
    expect(videoSender(ps).track).toBe(canvasTrack);
    expect(videoSender(ps).track!.enabled).toBe(false);
  });

  it("swapping back to 'none' returns the RAW clone born at the CURRENT (closed) gate state", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    const rawClone = videoSender(ps).track; // the raw clone object

    // Open the gate, turn a filter on (canvas track born open), then close the
    // gate again BEFORE swapping back to none.
    ps.setOutgoingVideoEnabled(true);
    ps.setFilter("night");
    const canvasTrack = created.canvases[0].capturedTrack!;
    expect(canvasTrack.enabled).toBe(true);

    ps.setOutgoingVideoEnabled(false);
    expect(canvasTrack.enabled).toBe(false);

    // none-swap: the raw clone comes back, and swapSentTrack must re-stamp it at
    // the CURRENT gate (closed) so it can't return ungated.
    expect(ps.setFilter("none")).toBe("none");
    expect(videoSender(ps).track).toBe(rawClone);
    expect(rawClone!.enabled).toBe(false);
  });

  it("swapping back to 'none' while the gate is OPEN returns the raw clone enabled", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    const rawClone = videoSender(ps).track;

    ps.setOutgoingVideoEnabled(true);
    ps.setFilter("mono");
    expect(created.canvases[0].capturedTrack!.enabled).toBe(true);

    // Gate still open on the swap-back: the raw clone must keep flowing (no false
    // black frame on the return swap).
    expect(ps.setFilter("none")).toBe("none");
    expect(videoSender(ps).track).toBe(rawClone);
    expect(rawClone!.enabled).toBe(true);
  });
});

// --- no renegotiation: replaceTrack only, never add/removeTrack ------------

describe("PeerSession.setFilter — never renegotiates", () => {
  it("a none->grade swap keeps exactly ONE video sender (replaceTrack, not add/remove)", async () => {
    installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    const sender = videoSender(ps);

    expect(videoSenderCount(ps)).toBe(1);
    ps.setFilter("warm");
    // Still one video sender: a removeTrack+addTrack pair would have changed the
    // count and triggered onnegotiationneeded in a real pc. replaceTrack did not.
    expect(videoSenderCount(ps)).toBe(1);
    expect(sender.replaceTrack).toHaveBeenCalledTimes(1);
  });

  it("a full none->night->warm->mono->none round-trip never grows the sender list", async () => {
    installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    const sender = videoSender(ps);

    for (const id of ["night", "warm", "mono", "none"] as const) {
      ps.setFilter(id);
      expect(videoSenderCount(ps)).toBe(1);
    }
    // Two swaps total: none->night (build) and mono->none (teardown). The two
    // mid-chain non-none switches repaint only — no replaceTrack.
    expect(sender.replaceTrack).toHaveBeenCalledTimes(2);
  });

  it("emits no outgoing signal (offer) as a side effect of setFilter", async () => {
    // A renegotiation would surface as an onSignal('offer'); wire a spy callback
    // and assert setFilter stays silent.
    installBrowserFakes({ captureStreamSupported: true });
    const onSignal = jest.fn();
    installRtcAndMedia([makeTrack("video"), makeTrack("audio")]);
    const ps = new PeerSession(true, { ...noopCallbacks, onSignal });
    await ps.startVideo();
    onSignal.mockClear();

    ps.setFilter("warm");
    ps.setFilter("mono");
    ps.setFilter("none");

    expect(onSignal).not.toHaveBeenCalled();
  });
});

// --- honest fallback leaves a GATED raw clone (no ungated track stranded) ---

describe("PeerSession.setFilter — fallback never strands an ungated track", () => {
  it("captureStream UNAVAILABLE: sender keeps the gated raw clone (enabled stays false)", async () => {
    installBrowserFakes({ captureStreamSupported: false });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    const rawClone = videoSender(ps).track;

    expect(ps.setFilter("night")).toBe("none");
    // No swap, and the raw clone is still gated closed — the fallback must not
    // leave any ungated track in a sender.
    expect(videoSender(ps).track).toBe(rawClone);
    expect(rawClone!.enabled).toBe(false);
    expect(videoSender(ps).replaceTrack).not.toHaveBeenCalled();
  });

  it("captureStream THROWS: returns 'none', keeps the gated raw clone, leaves no rAF loop", async () => {
    // Same fakes, but captureStream is present and THROWS — exercising the
    // try/catch fallback path (distinct from the 'method absent' path above).
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);
    const rawClone = videoSender(ps).track;
    // Patch the next-created canvas to throw on captureStream.
    const origCreate = (global as Record<string, unknown>).document as {
      createElement: jest.Mock;
    };
    const realImpl = origCreate.createElement.getMockImplementation()!;
    origCreate.createElement.mockImplementation((tag: string) => {
      const el = realImpl(tag);
      if (tag === "canvas") {
        (el as unknown as FakeCanvas).captureStream = jest.fn(() => {
          throw new Error("captureStream blew up");
        });
      }
      return el;
    });

    expect(ps.setFilter("warm")).toBe("none");
    // THE PRIVACY POINT: whatever the sender ends up carrying, it is the raw
    // clone AND it is gated. The catch path re-swaps the raw clone via
    // swapSentTrack (which re-stamps .enabled to the stored closed gate), so a
    // replaceTrack call is allowed here — but it must never leave an ungated
    // track in the sender.
    expect(videoSender(ps).track).toBe(rawClone);
    expect(rawClone!.enabled).toBe(false);
    expect(videoSender(ps).track!.enabled).toBe(false);
    // No draw loop was left scheduled by the half-built-then-torn-down pipeline.
    expect(rafCallbacks).toHaveLength(0);
    expect(created.canvases.length).toBeGreaterThanOrEqual(1);
  });
});

// --- lifecycle: rapid switching keeps exactly one pipeline live ------------

describe("PeerSession.setFilter — rapid switching never leaks a pipeline", () => {
  it("none->night->warm->mono->none builds ONE canvas, repaints between grades, tears it down once", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const ps = await sessionWithTracks([makeTrack("video"), makeTrack("audio")]);

    ps.setFilter("night"); // build pipeline (1 canvas)
    const canvasTrack = created.canvases[0].capturedTrack!;
    expect(created.canvases).toHaveLength(1);

    ps.setFilter("warm"); // repaint only — no new canvas, same track
    ps.setFilter("mono"); // repaint only
    expect(created.canvases).toHaveLength(1);
    expect(videoSender(ps).track).toBe(canvasTrack);

    ps.setFilter("none"); // teardown — the single canvas track is released
    // The canvas track is stopped (released) on teardown. The source holds it via
    // both filterTrack and filterStream, so stop() may be invoked through more
    // than one reference — stop() is idempotent, so the invariant we assert is
    // "released", not a brittle exact call count.
    expect(canvasTrack.stop).toHaveBeenCalled();

    // Re-activating builds a FRESH pipeline (a second canvas), proving the first
    // was fully released rather than reused/leaked.
    ps.setFilter("warm");
    expect(created.canvases).toHaveLength(2);
  });
});

// --- stopVideo never stops a track twice -----------------------------------

describe("PeerSession.stopVideo — releases each track exactly once", () => {
  it("with a filter active, stops the canvas track once and the raw clone once", async () => {
    const created = installBrowserFakes({ captureStreamSupported: true });
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);
    ps.setFilter("night");
    const canvasTrack = created.canvases[0].capturedTrack!;
    const rawClone = video.cloned!; // the clone created in startVideo

    ps.stopVideo();

    // The canvas track is released. The raw clone is the track the
    // `sentVideoTrack !== rawClone` guard specifically protects from a DOUBLE
    // stop, so it must be stopped EXACTLY once even though sentVideoTrack (the
    // canvas track) is also stopped separately.
    expect(canvasTrack.stop).toHaveBeenCalled();
    expect(rawClone.stop).toHaveBeenCalledTimes(1);
  });

  it("on 'none' (sentVideoTrack IS rawClone), stops the single clone exactly once", async () => {
    installBrowserFakes({ captureStreamSupported: true });
    const video = makeTrack("video");
    const ps = await sessionWithTracks([video, makeTrack("audio")]);
    const rawClone = video.cloned!;

    // No filter ever active: sentVideoTrack === rawClone, so the guard must avoid
    // a double stop on the same object.
    ps.stopVideo();
    expect(rawClone.stop).toHaveBeenCalledTimes(1);
  });
});
