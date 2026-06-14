/**
 * Phase 4 — TokenBucket unit tests (the shared chat flood-clamp primitive).
 *
 * lib/chatRate.ts is the ONE source of truth for the chat rate limit; both the
 * inbound clamp (webrtc.ts) and the outbound cooldown (ChatPanel.tsx) read it,
 * so its arithmetic is the contract everything else inherits. We drive it with
 * an injectable `now` (the bucket takes a caller-supplied timestamp on every
 * method) so these tests are deterministic WITHOUT fake timers — there is no
 * real clock, no sleep, no flakiness.
 *
 * We assert observable behaviour (allow/deny, time-to-next, restoration after
 * drain) — never private token counts.
 */
import {
  CHAT_RATE,
  INBOUND_CHAT_GRACE,
  TokenBucket,
  createChatBucket,
  createInboundChatBucket,
} from "./chatRate";

describe("CHAT_RATE shared constant", () => {
  it("exposes the tunable the rest of the feature reads (capacity 5 / 1s refill)", () => {
    // Both call sites import these numbers; pin them so an accidental edit that
    // would silently move the inbound clamp and outbound cooldown out of step
    // is caught here.
    expect(CHAT_RATE.capacity).toBe(5);
    expect(CHAT_RATE.refillMs).toBe(1_000);
  });
});

describe("TokenBucket.tryRemove — capacity boundary", () => {
  it("allows exactly `capacity` back-to-back spends, then denies the next", () => {
    const cap = 5;
    const bucket = new TokenBucket(cap, 1_000, 0);

    // Exactly at capacity: every one of the first `cap` spends is allowed.
    for (let i = 0; i < cap; i++) {
      expect(bucket.tryRemove(0)).toBe(true);
    }
    // capacity + 1: the bucket is empty, so this spend is denied.
    expect(bucket.tryRemove(0)).toBe(false);
  });

  it("stays denied while no time passes (no spontaneous refill at t=now)", () => {
    const bucket = new TokenBucket(2, 1_000, 0);
    expect(bucket.tryRemove(0)).toBe(true);
    expect(bucket.tryRemove(0)).toBe(true);
    // Drained; repeated calls at the same instant keep returning false.
    expect(bucket.tryRemove(0)).toBe(false);
    expect(bucket.tryRemove(0)).toBe(false);
  });
});

describe("TokenBucket refill over time", () => {
  it("grants one more spend after a full refill window elapses", () => {
    const bucket = new TokenBucket(2, 1_000, 0);
    bucket.tryRemove(0);
    bucket.tryRemove(0);
    expect(bucket.tryRemove(0)).toBe(false); // empty

    // Advance one whole refill window: exactly one token returns.
    expect(bucket.tryRemove(1_000)).toBe(true);
    expect(bucket.tryRemove(1_000)).toBe(false); // and only one
  });

  it("does NOT over-refill on a partial window (sub-window time grants nothing)", () => {
    const bucket = new TokenBucket(2, 1_000, 0);
    bucket.tryRemove(0);
    bucket.tryRemove(0);

    // 999ms < one window: still no token.
    expect(bucket.tryRemove(999)).toBe(false);
    // The leftover fraction is preserved: at 1000ms total the token lands.
    expect(bucket.tryRemove(1_000)).toBe(true);
  });

  it("credits multiple tokens after multiple windows but never exceeds capacity", () => {
    const cap = 3;
    const bucket = new TokenBucket(cap, 1_000, 0);
    // Drain fully.
    for (let i = 0; i < cap; i++) bucket.tryRemove(0);
    expect(bucket.tryRemove(0)).toBe(false);

    // Idle for 100 windows — far more than capacity. The bucket must clamp the
    // refill at `capacity`, never bank infinite tokens.
    expect(bucket.hasCapacity(100_000)).toBe(true);
    let granted = 0;
    while (bucket.tryRemove(100_000)) granted++;
    expect(granted).toBe(cap);
  });
});

describe("TokenBucket.msUntilNext", () => {
  it("returns 0 while a token is available", () => {
    const bucket = new TokenBucket(5, 1_000, 0);
    expect(bucket.msUntilNext(0)).toBe(0);
  });

  it("returns the remaining wait once empty, counting down as time passes", () => {
    const bucket = new TokenBucket(1, 1_000, 0);
    bucket.tryRemove(0); // drain the single token

    // Just emptied: a full window remains.
    expect(bucket.msUntilNext(0)).toBe(1_000);
    // 400ms in: 600ms left.
    expect(bucket.msUntilNext(400)).toBe(600);
    // At the boundary the wait is 0 again (a token is back).
    expect(bucket.msUntilNext(1_000)).toBe(0);
  });
});

describe("TokenBucket — no permanent lockout", () => {
  it("fully restores capacity after a drain once enough time elapses", () => {
    const cap = 5;
    const bucket = new TokenBucket(cap, 1_000, 0);
    for (let i = 0; i < cap; i++) bucket.tryRemove(0);
    expect(bucket.tryRemove(0)).toBe(false);

    // Wait out a generous span (>= capacity windows): full burst available again.
    const later = cap * 1_000;
    let restored = 0;
    while (bucket.tryRemove(later)) restored++;
    expect(restored).toBe(cap);
  });

  it("non-monotonic / backwards `now` does not refill (and does not throw)", () => {
    // Defensive: a clock that goes backwards must not gift tokens.
    const bucket = new TokenBucket(1, 1_000, 1_000);
    expect(bucket.tryRemove(1_000)).toBe(true);
    expect(bucket.tryRemove(1_000)).toBe(false);
    expect(() => bucket.tryRemove(500)).not.toThrow();
    expect(bucket.tryRemove(500)).toBe(false); // earlier time -> still empty
  });
});

describe("createChatBucket", () => {
  it("builds a bucket pre-loaded with the shared CHAT_RATE capacity", () => {
    const bucket = createChatBucket(0);
    let allowed = 0;
    while (bucket.tryRemove(0)) allowed++;
    // A fresh chat bucket grants exactly CHAT_RATE.capacity immediate spends.
    expect(allowed).toBe(CHAT_RATE.capacity);
  });

  it("refills on the shared CHAT_RATE cadence", () => {
    const bucket = createChatBucket(0);
    while (bucket.tryRemove(0)) {
      /* drain */
    }
    expect(bucket.tryRemove(0)).toBe(false);
    // One CHAT_RATE.refillMs later, one spend returns.
    expect(bucket.tryRemove(CHAT_RATE.refillMs)).toBe(true);
  });
});

describe("createInboundChatBucket — honesty invariant (inbound strictly > outbound)", () => {
  it("grants strictly MORE burst capacity than the outbound bucket", () => {
    const outbound = createChatBucket(0);
    const inbound = createInboundChatBucket(0);

    let out = 0;
    while (outbound.tryRemove(0)) out++;
    let inn = 0;
    while (inbound.tryRemove(0)) inn++;

    expect(inn).toBe(CHAT_RATE.capacity + INBOUND_CHAT_GRACE);
    // The whole point: a compliant sender's burst can never exceed what a
    // compliant receiver will admit — inbound is strictly the larger budget.
    expect(inn).toBeGreaterThan(out);
  });

  it("refills on the SAME cadence as outbound (only the ceiling differs)", () => {
    const inbound = createInboundChatBucket(0);
    while (inbound.tryRemove(0)) {
      /* drain */
    }
    expect(inbound.tryRemove(0)).toBe(false);
    expect(inbound.tryRemove(CHAT_RATE.refillMs)).toBe(true);
  });

  it("absorbs clock skew: a sender-approved message is NOT dropped by a receiver whose clock lags", () => {
    // Two independent wall clocks. The sender throttles itself with the
    // outbound bucket; the receiver clamps with the inbound bucket. The
    // receiver's clock lags the sender's by a sub-window amount — the exact
    // condition that, WITHOUT the grace, silently drops a compliant message
    // (QA finding #3). With the grace, the receiver still admits it.
    const SKEW = Math.floor(CHAT_RATE.refillMs / 2); // receiver runs behind
    const sender = createChatBucket(0);
    const receiver = createInboundChatBucket(0);

    // Sender drains its burst at t=0 (all approved locally) and the receiver
    // admits every one of them.
    for (let i = 0; i < CHAT_RATE.capacity; i++) {
      expect(sender.tryRemove(0)).toBe(true);
      expect(receiver.tryRemove(0)).toBe(true);
    }

    // A refill window passes on the SENDER's clock: its bucket grants one more.
    expect(sender.tryRemove(CHAT_RATE.refillMs)).toBe(true);

    // The receiver sees that same message a touch later but its clock is behind,
    // so from its perspective the refill window hasn't fully elapsed yet. The
    // grace headroom means it still admits the compliant message instead of
    // silently dropping it.
    const receiverNow = CHAT_RATE.refillMs - SKEW;
    expect(receiver.tryRemove(receiverNow)).toBe(true);
  });
});
