/**
 * Phase 4 — inbound chat flood clamp + type-awareness (the critical invariants).
 *
 * Target: PeerSession.wireDataChannel()'s dc.onmessage handler. The {t:"msg"}
 * (chat) branch now spends a token from a per-session flood-clamp bucket before
 * firing onChat; over-limit chat is dropped SILENTLY (onChat simply isn't
 * called). The {t:"ctrl"} and {t:"typing"} branches must NEVER touch that
 * bucket — that is the non-negotiable invariant protecting the shipped
 * reciprocal-video presence shield: a chat flood can never starve a presence
 * heartbeat or a typing signal.
 *
 * We assert observable callback behaviour (which of onChat / onControl /
 * onTyping fire, and how many times), never private token counts.
 *
 * Determinism: the clamp inside webrtc.ts reads wall-clock Date.now(). We stub
 * Date.now with a controllable value (NO fake timers, NO real sleeps) so the
 * refill window is advanced explicitly and the tests can never flake on timing.
 * The fixture mirrors webrtc.presence.test.ts's TypingFakeRTCPeerConnection +
 * deliver() helper (each test file owns its own fakes).
 */
import { PeerSession, type PeerControl } from "./webrtc";
import { CHAT_RATE, INBOUND_CHAT_GRACE } from "./chatRate";

// --- Fakes (mirror of the presence-suite data-channel fixture) -------------

type FakeDataChannel = {
  readyState: string;
  send: jest.Mock;
  close: jest.Mock;
  onmessage: ((e: { data: string }) => void) | null;
};

class ChatFakeRTCPeerConnection {
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: unknown) => void) | null = null;
  connectionState: RTCPeerConnectionState = "new";
  // The most recently created channel — the one PeerSession wired onmessage on.
  lastChannel: FakeDataChannel | null = null;

  createDataChannel() {
    const channel: FakeDataChannel = {
      readyState: "connecting",
      send: jest.fn(),
      close: jest.fn(),
      onmessage: null,
    };
    this.lastChannel = channel;
    return channel as unknown as RTCDataChannel;
  }
  getSenders() {
    return [];
  }
  close() {}
}

const noopCallbacks = {
  onSignal: () => {},
  onChat: () => {},
  onControl: () => {},
  onTyping: () => {},
  onRemoteStream: () => {},
  onConnectionState: () => {},
  onChannelOpen: () => {},
};

const RealRTC = (global as Record<string, unknown>).RTCPeerConnection;
const realNavigator = (global as Record<string, unknown>).navigator;
const realDateNow = Date.now;

// A controllable clock the clamp's Date.now() reads. Start at a fixed origin so
// every test is reproducible.
let clock = 1_000_000;
function advance(ms: number) {
  clock += ms;
}

beforeEach(() => {
  clock = 1_000_000;
  Date.now = () => clock;
  (global as Record<string, unknown>).RTCPeerConnection =
    ChatFakeRTCPeerConnection;
  (global as Record<string, unknown>).navigator = {
    mediaDevices: { getUserMedia: jest.fn() },
  };
});

afterEach(() => {
  Date.now = realDateNow;
  (global as Record<string, unknown>).RTCPeerConnection = RealRTC;
  (global as Record<string, unknown>).navigator = realNavigator;
  jest.restoreAllMocks();
});

/**
 * Build an initiator PeerSession (channel created synchronously in the ctor, so
 * onmessage is already wired) and return the wired channel plus the callback
 * spies the test cares about.
 */
function sessionWithChannel(
  spies: Partial<{
    onChat: jest.Mock;
    onControl: jest.Mock;
    onTyping: jest.Mock;
  }> = {},
) {
  const onChat = spies.onChat ?? jest.fn();
  const onControl = spies.onControl ?? jest.fn();
  const onTyping = spies.onTyping ?? jest.fn();
  const ps = new PeerSession(true, {
    ...noopCallbacks,
    onChat,
    onControl,
    onTyping,
  });
  const pc = (ps as unknown as { pc: ChatFakeRTCPeerConnection }).pc;
  const channel = pc.lastChannel;
  if (!channel || !channel.onmessage) {
    throw new Error("expected the initiator channel to have onmessage wired");
  }
  return { ps, channel, onChat, onControl, onTyping };
}

/** Deliver a raw frame exactly as the browser does: an event with `.data`. */
function deliver(channel: FakeDataChannel, data: string) {
  channel.onmessage!({ data });
}
function deliverChat(channel: FakeDataChannel, text: string) {
  deliver(channel, JSON.stringify({ t: "msg", text }));
}
function deliverCtrl(channel: FakeDataChannel, ctrl: PeerControl) {
  deliver(channel, JSON.stringify({ t: "ctrl", ctrl }));
}

// The INBOUND clamp is deliberately more permissive than the outbound limit by
// INBOUND_CHAT_GRACE, so that clock skew between peers can never silently drop a
// compliant sender's message. So the receiver-side boundary these tests probe
// is the GRACED capacity, not the bare CHAT_RATE.capacity (which is the
// sender's stricter self-limit, covered in chatRate.test.ts).
const CAP = CHAT_RATE.capacity + INBOUND_CHAT_GRACE;

// --- Inbound clamp: in-rate vs over-limit ----------------------------------

describe("PeerSession inbound chat clamp — in-rate delivery", () => {
  it("delivers EVERY chat message up to exactly capacity (boundary)", () => {
    const { channel, onChat } = sessionWithChannel();

    for (let i = 0; i < CAP; i++) deliverChat(channel, `m${i}`);

    // All `capacity` in-window frames reached onChat, in order.
    expect(onChat).toHaveBeenCalledTimes(CAP);
    for (let i = 0; i < CAP; i++) {
      expect(onChat).toHaveBeenNthCalledWith(i + 1, `m${i}`);
    }
  });
});

describe("PeerSession inbound chat clamp — over-limit drop", () => {
  it("drops chat beyond capacity: capacity+1 frames -> exactly capacity onChat calls", () => {
    const { channel, onChat } = sessionWithChannel();

    for (let i = 0; i < CAP + 1; i++) deliverChat(channel, `m${i}`);

    // The (capacity+1)th frame is silently dropped.
    expect(onChat).toHaveBeenCalledTimes(CAP);
    // The delivered ones are the first `capacity`, not the last.
    expect(onChat).toHaveBeenNthCalledWith(CAP, `m${CAP - 1}`);
  });

  it("a large flood in one window still delivers only capacity", () => {
    const { channel, onChat } = sessionWithChannel();

    for (let i = 0; i < CAP * 10; i++) deliverChat(channel, `flood${i}`);

    expect(onChat).toHaveBeenCalledTimes(CAP);
  });
});

describe("PeerSession inbound chat clamp — window recovery (no lockout)", () => {
  it("passes in-rate chat again after a refill window elapses", () => {
    const { channel, onChat } = sessionWithChannel();

    // Drain the budget, then overrun by one (dropped).
    for (let i = 0; i < CAP; i++) deliverChat(channel, `a${i}`);
    deliverChat(channel, "dropped");
    expect(onChat).toHaveBeenCalledTimes(CAP);

    // Advance one refill window: one token returns, so one more passes.
    advance(CHAT_RATE.refillMs);
    deliverChat(channel, "after-refill");
    expect(onChat).toHaveBeenCalledTimes(CAP + 1);
    expect(onChat).toHaveBeenLastCalledWith("after-refill");
  });

  it("fully restores the burst after a long idle (capacity passes again)", () => {
    const { channel, onChat } = sessionWithChannel();
    for (let i = 0; i < CAP; i++) deliverChat(channel, `a${i}`);
    onChat.mockClear();

    // Idle well beyond capacity windows, then flood again.
    advance(CHAT_RATE.refillMs * CAP);
    for (let i = 0; i < CAP + 3; i++) deliverChat(channel, `b${i}`);

    // A full fresh burst of `capacity` is delivered (extra still dropped).
    expect(onChat).toHaveBeenCalledTimes(CAP);
  });
});

// --- TYPE-AWARENESS: the non-negotiable invariants -------------------------

describe("PeerSession inbound clamp — type-awareness (presence-shield protection)", () => {
  it("a chat flood NEVER drops a ctrl frame: every interleaved ctrl reaches onControl", () => {
    const { channel, onChat, onControl } = sessionWithChannel();

    // Interleave a heavy chat flood with presence/video ctrl frames. The chat
    // budget will be exhausted many times over, but ctrl is off the budget.
    const ctrls: PeerControl[] = [
      "presence-present",
      "presence-away",
      "video-request",
      "presence-present",
      "video-end",
    ];
    for (let i = 0; i < ctrls.length; i++) {
      // 4 chat frames per ctrl -> 20 chat frames, far over capacity.
      for (let j = 0; j < 4; j++) deliverChat(channel, `c${i}-${j}`);
      deliverCtrl(channel, ctrls[i]);
    }

    // EVERY ctrl frame got through, in order — the shield is never starved.
    expect(onControl).toHaveBeenCalledTimes(ctrls.length);
    ctrls.forEach((c, i) =>
      expect(onControl).toHaveBeenNthCalledWith(i + 1, c),
    );
    // Chat itself was clamped to capacity, proving the flood really overran.
    expect(onChat).toHaveBeenCalledTimes(CAP);
  });

  it("typing frames are NOT on the chat budget: typing fires after the chat budget is exhausted", () => {
    const { channel, onChat, onTyping } = sessionWithChannel();

    // Exhaust (and overrun) the chat budget completely.
    for (let i = 0; i < CAP + 2; i++) deliverChat(channel, `m${i}`);
    expect(onChat).toHaveBeenCalledTimes(CAP);

    // With zero chat tokens left, typing still dispatches normally.
    deliver(channel, JSON.stringify({ t: "typing", on: true }));
    deliver(channel, JSON.stringify({ t: "typing", on: false }));
    expect(onTyping).toHaveBeenCalledTimes(2);
    expect(onTyping).toHaveBeenNthCalledWith(1, true);
    expect(onTyping).toHaveBeenNthCalledWith(2, false);
  });

  it("an unknown / future msg.t value passes through without throwing or dispatching chat", () => {
    const { channel, onChat, onControl, onTyping } = sessionWithChannel();

    expect(() =>
      deliver(channel, JSON.stringify({ t: "reaction", emoji: "👍" })),
    ).not.toThrow();
    // Forward-compatible: an unknown type is simply ignored by every branch and
    // crucially does NOT spend a chat token.
    expect(onChat).not.toHaveBeenCalled();
    expect(onControl).not.toHaveBeenCalled();
    expect(onTyping).not.toHaveBeenCalled();

    // Budget untouched: a full capacity of real chat still gets through after.
    for (let i = 0; i < CAP; i++) deliverChat(channel, `m${i}`);
    expect(onChat).toHaveBeenCalledTimes(CAP);
  });
});

// --- Robustness: dropped chat must not corrupt the handler -----------------

describe("PeerSession inbound clamp — robustness", () => {
  it("a dropped over-limit chat does not throw out of onmessage", () => {
    const { channel } = sessionWithChannel();
    for (let i = 0; i < CAP; i++) deliverChat(channel, `m${i}`);
    // The drop path must be silent, not exceptional.
    expect(() => deliverChat(channel, "over-limit")).not.toThrow();
  });

  it("dropping chat does not break future in-rate delivery after a refill", () => {
    const { channel, onChat } = sessionWithChannel();

    // Overrun heavily (lots of drops).
    for (let i = 0; i < CAP * 5; i++) deliverChat(channel, `f${i}`);
    expect(onChat).toHaveBeenCalledTimes(CAP);

    // After a refill, delivery resumes correctly — drops left no bad state.
    advance(CHAT_RATE.refillMs);
    deliverChat(channel, "healthy");
    expect(onChat).toHaveBeenLastCalledWith("healthy");
    expect(onChat).toHaveBeenCalledTimes(CAP + 1);
  });

  it("a chat frame missing its `text` is ignored and does NOT spend a token", () => {
    const { channel, onChat } = sessionWithChannel();

    // Malformed chat (no string text) — the typeof guard rejects it before the
    // bucket, so it neither dispatches nor consumes budget.
    deliver(channel, JSON.stringify({ t: "msg" }));
    deliver(channel, JSON.stringify({ t: "msg", text: 42 }));
    expect(onChat).not.toHaveBeenCalled();

    // Full capacity of valid chat still available afterwards.
    for (let i = 0; i < CAP; i++) deliverChat(channel, `m${i}`);
    expect(onChat).toHaveBeenCalledTimes(CAP);
  });
});
