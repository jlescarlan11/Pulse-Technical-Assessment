/**
 * Delivery Echo — protocol-level invariants on the data channel.
 *
 * Target: PeerSession's sendChat()/sendAck() (the wire framing) and the
 * dc.onmessage dispatch for the new id-carrying chat + ack frames. The honest
 * "Delivered" signal rides the existing P2P data channel and NEVER touches the
 * server:
 *   - sendChat(text, id) now emits {t:"msg", text, id}.
 *   - An inbound {t:"msg", text, id} that PASSES the flood clamp and reaches
 *     onChat triggers a {t:"ack", id} echo back with the SAME id. A clamped
 *     (dropped) chat sends NO ack — so the sender honestly stays at "Sent".
 *   - An id-less chat (older peer) is delivered but gets NO ack (backward compat).
 *   - An inbound {t:"ack", id} fires onDelivered(id) and is EXEMPT from the flood
 *     clamp (an ack flood must still deliver every onDelivered — clamping acks
 *     would falsely strand delivered messages at "Sent").
 *
 * We assert observable behaviour: which callbacks fire, and the exact frames
 * written to dc.send — never private token counts.
 *
 * Determinism mirrors webrtc.chatclamp.test.ts: the clamp reads wall-clock
 * Date.now(), so we stub it with a controllable value (NO fake timers, NO real
 * sleeps). The fixture mirrors that suite's ChatFakeRTCPeerConnection + deliver()
 * helper (each test file owns its own fakes).
 */
import { PeerSession } from "./webrtc";
import { CHAT_RATE, INBOUND_CHAT_GRACE } from "./chatRate";

// --- Fakes (mirror of the chatclamp-suite data-channel fixture) ------------

type FakeDataChannel = {
  readyState: string;
  send: jest.Mock;
  close: jest.Mock;
  onmessage: ((e: { data: string }) => void) | null;
};

class DeliveryFakeRTCPeerConnection {
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: unknown) => void) | null = null;
  connectionState: RTCPeerConnectionState = "new";
  // The most recently created channel — the one PeerSession wired onmessage on.
  lastChannel: FakeDataChannel | null = null;

  createDataChannel() {
    // Born "open" so safeSend (which guards on readyState === "open") actually
    // writes the outbound msg/ack frames the protocol tests inspect.
    const channel: FakeDataChannel = {
      readyState: "open",
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
  onDelivered: () => {},
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
    DeliveryFakeRTCPeerConnection;
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
 * onmessage is already wired AND the channel is "open" for sends) and return the
 * wired channel plus the callback spies the test cares about.
 */
function sessionWithChannel(
  spies: Partial<{ onChat: jest.Mock; onDelivered: jest.Mock }> = {},
) {
  const onChat = spies.onChat ?? jest.fn();
  const onDelivered = spies.onDelivered ?? jest.fn();
  const ps = new PeerSession(true, { ...noopCallbacks, onChat, onDelivered });
  const pc = (ps as unknown as { pc: DeliveryFakeRTCPeerConnection }).pc;
  const channel = pc.lastChannel;
  if (!channel || !channel.onmessage) {
    throw new Error("expected the initiator channel to have onmessage wired");
  }
  return { ps, channel, onChat, onDelivered };
}

/** Deliver a raw frame exactly as the browser does: an event with `.data`. */
function deliver(channel: FakeDataChannel, data: string) {
  channel.onmessage!({ data });
}

/** Every frame written to dc.send, parsed back into objects, in send order. */
function sentFrames(channel: FakeDataChannel): Array<Record<string, unknown>> {
  return channel.send.mock.calls.map(
    ([raw]) => JSON.parse(raw as string) as Record<string, unknown>,
  );
}

// The INBOUND clamp is more permissive than the bare CHAT_RATE by
// INBOUND_CHAT_GRACE (clock-skew safety); the receiver-side boundary is that
// graced capacity, matching webrtc.chatclamp.test.ts.
const CAP = CHAT_RATE.capacity + INBOUND_CHAT_GRACE;

// --- AC1: sendChat frames the numeric id ------------------------------------

describe("Delivery Echo — sendChat wire framing", () => {
  it("sendChat(text, id) emits a {t:'msg'} frame carrying the text AND the numeric id", () => {
    const { ps, channel } = sessionWithChannel();

    ps.sendChat("hello", 42);

    const frames = sentFrames(channel);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ t: "msg", text: "hello", id: 42 });
  });
});

// --- AC2: an in-rate inbound chat is delivered AND acked back ---------------

describe("Delivery Echo — ack on successful inbound delivery", () => {
  it("inbound {t:'msg', text, id} that PASSES the clamp -> onChat fires AND a {t:'ack', id} with the SAME id is sent back", () => {
    const { channel, onChat } = sessionWithChannel();

    deliver(channel, JSON.stringify({ t: "msg", text: "hi", id: 7 }));

    // It reached this client...
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(onChat).toHaveBeenCalledWith("hi");
    // ...so exactly one ack echoes the SAME id straight back.
    const frames = sentFrames(channel);
    expect(frames).toEqual([{ t: "ack", id: 7 }]);
  });

  it("echoes each id distinctly: two in-rate messages produce two acks with their own ids, in order", () => {
    const { channel, onChat } = sessionWithChannel();

    deliver(channel, JSON.stringify({ t: "msg", text: "a", id: 11 }));
    deliver(channel, JSON.stringify({ t: "msg", text: "b", id: 12 }));

    expect(onChat).toHaveBeenCalledTimes(2);
    expect(sentFrames(channel)).toEqual([
      { t: "ack", id: 11 },
      { t: "ack", id: 12 },
    ]);
  });
});

// --- AC3: a clamped (dropped) chat is NOT delivered and NOT acked -----------

describe("Delivery Echo — dropped chat sends no ack (honest 'Sent')", () => {
  it("a chat DROPPED by the flood clamp -> onChat NOT called for it AND NO ack sent for it", () => {
    const { channel, onChat } = sessionWithChannel();

    // Saturate the inbound budget with in-rate chat (each of these IS acked),
    // then the (CAP+1)th frame is silently dropped.
    for (let i = 0; i < CAP; i++) {
      deliver(channel, JSON.stringify({ t: "msg", text: `m${i}`, id: i }));
    }
    deliver(channel, JSON.stringify({ t: "msg", text: "dropped", id: 9999 }));

    // The over-limit frame never reached onChat...
    expect(onChat).toHaveBeenCalledTimes(CAP);
    // ...and crucially produced NO ack: only the CAP in-rate frames acked, and
    // the dropped id (9999) is absent from every ack frame.
    const acks = sentFrames(channel).filter((f) => f.t === "ack");
    expect(acks).toHaveLength(CAP);
    expect(acks.some((f) => f.id === 9999)).toBe(false);
  });
});

// --- AC4: backward compat — an id-less chat is delivered but NOT acked ------

describe("Delivery Echo — backward compatibility (id-less peer)", () => {
  it("inbound {t:'msg', text} with NO id -> onChat fires, NO ack sent", () => {
    const { channel, onChat } = sessionWithChannel();

    deliver(channel, JSON.stringify({ t: "msg", text: "legacy" }));

    // The text still renders (older peer interop)...
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(onChat).toHaveBeenCalledWith("legacy");
    // ...but there is nothing to echo, so no ack is written at all.
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("a non-numeric id on an inbound chat -> delivered, but still no ack (only numeric ids are echoed)", () => {
    const { channel, onChat } = sessionWithChannel();

    deliver(channel, JSON.stringify({ t: "msg", text: "x", id: "not-a-number" }));

    expect(onChat).toHaveBeenCalledWith("x");
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("a non-INTEGER id (float) on an inbound chat -> delivered, but still no ack", () => {
    // Same Number.isInteger guard on the echo path: a malformed float id renders
    // the message but is never echoed back as an ack.
    const { channel, onChat } = sessionWithChannel();

    deliver(channel, '{"t":"msg","text":"y","id":2.5}');

    expect(onChat).toHaveBeenCalledWith("y");
    expect(channel.send).not.toHaveBeenCalled();
  });
});

// --- AC5: inbound ack drives onDelivered, and acks are clamp-EXEMPT ----------

describe("Delivery Echo — inbound ack drives onDelivered (clamp-exempt)", () => {
  it("inbound {t:'ack', id} -> onDelivered(id) called with that id", () => {
    const { channel, onDelivered } = sessionWithChannel();

    deliver(channel, JSON.stringify({ t: "ack", id: 321 }));

    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(onDelivered).toHaveBeenCalledWith(321);
  });

  it("acks are NOT subject to the flood clamp: an ack flood beyond chat capacity still fires onDelivered for EVERY ack", () => {
    const { channel, onDelivered } = sessionWithChannel();

    // Far more acks than the chat clamp's capacity. If acks shared the chat
    // budget, the surplus would be dropped and onDelivered would stop firing —
    // falsely stranding delivered messages at "Sent". They must ALL get through.
    const floodCount = CAP * 5;
    for (let i = 0; i < floodCount; i++) {
      deliver(channel, JSON.stringify({ t: "ack", id: i }));
    }

    expect(onDelivered).toHaveBeenCalledTimes(floodCount);
    // Every distinct id was delivered, in order.
    for (let i = 0; i < floodCount; i++) {
      expect(onDelivered).toHaveBeenNthCalledWith(i + 1, i);
    }
  });

  it("an ack flood does NOT starve the chat budget (acks never spend a chat token)", () => {
    const { channel, onChat, onDelivered } = sessionWithChannel();

    // Hammer acks first (would exhaust the chat budget many times over IF they
    // shared it)...
    for (let i = 0; i < CAP * 5; i++) {
      deliver(channel, JSON.stringify({ t: "ack", id: i }));
    }
    expect(onDelivered).toHaveBeenCalledTimes(CAP * 5);

    // ...then a full capacity of real chat still gets through untouched.
    for (let i = 0; i < CAP; i++) {
      deliver(channel, JSON.stringify({ t: "msg", text: `m${i}`, id: 1000 + i }));
    }
    expect(onChat).toHaveBeenCalledTimes(CAP);
  });
});

// --- AC6: malformed acks are ignored ----------------------------------------

describe("Delivery Echo — malformed acks ignored", () => {
  it("inbound {t:'ack'} with a MISSING id -> onDelivered NOT called, no throw", () => {
    const { channel, onDelivered } = sessionWithChannel();

    expect(() =>
      deliver(channel, JSON.stringify({ t: "ack" })),
    ).not.toThrow();
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it("inbound {t:'ack', id} with a NON-NUMERIC id -> onDelivered NOT called", () => {
    const { channel, onDelivered } = sessionWithChannel();

    deliver(channel, JSON.stringify({ t: "ack", id: "42" }));
    deliver(channel, JSON.stringify({ t: "ack", id: null }));
    deliver(channel, JSON.stringify({ t: "ack", id: { n: 1 } }));

    expect(onDelivered).not.toHaveBeenCalled();
  });

  it("inbound {t:'ack', id} with a NON-INTEGER number (float) -> onDelivered NOT called", () => {
    // ids are always the sender's small monotonic integer counter, so the guard
    // is Number.isInteger, NOT typeof === "number". A float is the realistic
    // non-integer that survives JSON.parse (NaN/Infinity aren't JSON-
    // representable) and the old typeof guard would have wrongly accepted it.
    const { channel, onDelivered } = sessionWithChannel();

    deliver(channel, '{"t":"ack","id":3.5}');

    expect(onDelivered).not.toHaveBeenCalled();
  });

  it("a malformed ack does not consume any chat budget (a later real chat still delivers)", () => {
    const { channel, onChat, onDelivered } = sessionWithChannel();

    deliver(channel, JSON.stringify({ t: "ack", id: "nope" }));
    expect(onDelivered).not.toHaveBeenCalled();

    // Budget untouched: a full capacity of valid chat still passes afterwards.
    for (let i = 0; i < CAP; i++) {
      deliver(channel, JSON.stringify({ t: "msg", text: `m${i}`, id: i }));
    }
    expect(onChat).toHaveBeenCalledTimes(CAP);
  });
});

// --- Robustness: refill window unaffected by the ack branch -----------------

describe("Delivery Echo — clamp recovery is unchanged by acks", () => {
  it("after draining the chat budget (each acked), a refill window lets one more chat pass and ack", () => {
    const { channel, onChat } = sessionWithChannel();

    for (let i = 0; i < CAP; i++) {
      deliver(channel, JSON.stringify({ t: "msg", text: `a${i}`, id: i }));
    }
    deliver(channel, JSON.stringify({ t: "msg", text: "dropped", id: 9999 }));
    expect(onChat).toHaveBeenCalledTimes(CAP);

    advance(CHAT_RATE.refillMs);
    deliver(channel, JSON.stringify({ t: "msg", text: "after", id: 5555 }));

    expect(onChat).toHaveBeenCalledTimes(CAP + 1);
    const acks = sentFrames(channel).filter((f) => f.t === "ack");
    // CAP in-rate + the post-refill one were acked; the dropped 9999 never was.
    expect(acks).toHaveLength(CAP + 1);
    expect(acks[acks.length - 1]).toEqual({ t: "ack", id: 5555 });
    expect(acks.some((f) => f.id === 9999)).toBe(false);
  });
});
