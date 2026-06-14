/**
 * Phase 4 — type-aware P2P chat flood clamp (render protection, NOT security).
 *
 * This is the ONE shared source of truth for the chat message rate limit. Both
 * sides of the feature import from here so they can never drift:
 *   - the INBOUND clamp in lib/webrtc.ts (drops excess incoming chat frames
 *     before they reach onChat, protecting the render path from a flood), and
 *   - the OUTBOUND cooldown in app/components/ChatPanel.tsx (disables the
 *     composer at the limit so a compliant client never silently overruns a
 *     compliant peer).
 *
 * Honesty note: we call this a "flood clamp" / "render protection", not a
 * security control. A hostile peer can fork the client; tab-close already
 * neutralises most of the threat. The clamp only keeps a runaway sender from
 * flooding the local render path.
 */

/**
 * The single tunable for the chat rate limit. A token bucket: it holds up to
 * `capacity` tokens and refills one token every `refillMs`. Each chat message
 * spends one token; when the bucket is empty the message is clamped (dropped
 * inbound / blocked outbound) until a token refills.
 *
 * Defaults: a comfortable-for-conversation burst of 5 messages, refilling one
 * slot every 1s (so ~5 msgs / 5s sustained). Tune BOTH numbers here and every
 * call site moves together — never hand-roll these values anywhere else.
 *
 * Honesty invariant: a compliant sender (one that throttled itself to
 * CHAT_RATE) must NEVER be silently dropped by a compliant receiver. The naive
 * version — give both sides the SAME capacity — holds only numerically. The two
 * peers run on independent wall clocks, so transient skew/jitter at a refill
 * boundary can let the sender's bucket grant token N while the receiver's
 * bucket is still empty, silently dropping a message the sender believed
 * compliant. We close that gap by running the INBOUND clamp strictly more
 * permissive than the outbound limit (see INBOUND_CHAT_GRACE /
 * createInboundChatBucket): the receiver tolerates a few extra burst tokens, so
 * "outbound <= inbound" holds TEMPORALLY across two clocks, not just on paper.
 */
export const CHAT_RATE = {
  /** Max messages that can fire back-to-back from an empty-wait state. */
  capacity: 5,
  /** Time to regenerate one token, in milliseconds. */
  refillMs: 1_000,
} as const;

/**
 * Extra burst headroom the INBOUND (receiver) clamp grants over the outbound
 * (sender) limit. Because peer clocks drift independently, a sender at the
 * exact refill boundary can be up to ~1 message "ahead" of the receiver's view;
 * this grace absorbs that skew so a compliant sender is never silently dropped.
 * It costs us almost nothing as flood protection (6–7 vs 5 in a burst is
 * immaterial to the render path) while making the honesty invariant real.
 */
export const INBOUND_CHAT_GRACE = 2;

/**
 * A minimal monotonic-ish token bucket. Timestamps come from a caller-supplied
 * `now` (defaults to Date.now) so it is trivially testable without fake timers.
 *
 * Not exported as a security primitive — see the file header. It is deliberately
 * dependency-free and synchronous so it can live inside a hot WebRTC message
 * handler and inside a React ref without pulling in any framework.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }

  /**
   * Attempt to spend one token. Returns true if a token was available (the
   * action is allowed) and false if the bucket is empty (clamp the action).
   */
  tryRemove(now: number = Date.now()): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** True if at least one token is currently available (non-mutating). */
  hasCapacity(now: number = Date.now()): boolean {
    this.refill(now);
    return this.tokens >= 1;
  }

  /**
   * Milliseconds until at least one token is available again, or 0 if a token
   * is available now. Lets the outbound UI schedule an exact auto-re-enable.
   */
  msUntilNext(now: number = Date.now()): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    const elapsed = now - this.lastRefill;
    return Math.max(0, this.refillMs - elapsed);
  }

  private refill(now: number): void {
    if (now <= this.lastRefill) return;
    const elapsed = now - this.lastRefill;
    const gained = Math.floor(elapsed / this.refillMs);
    if (gained <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    // Advance the clock only by the whole tokens we credited, so sub-token
    // fractional time isn't lost across calls.
    this.lastRefill += gained * this.refillMs;
  }
}

/**
 * Build the OUTBOUND (sender) bucket: the strict self-imposed limit. The
 * composer cools down at exactly this capacity so a compliant client never
 * tries to overrun a compliant peer.
 */
export function createChatBucket(now: number = Date.now()): TokenBucket {
  return new TokenBucket(CHAT_RATE.capacity, CHAT_RATE.refillMs, now);
}

/**
 * Build the INBOUND (receiver) clamp: strictly more permissive than the
 * outbound limit by INBOUND_CHAT_GRACE. This is what makes the honesty
 * invariant hold across two independent wall clocks — see CHAT_RATE's doc.
 * Same refill cadence, so steady-state behaviour matches; only the burst
 * ceiling is higher, which is what absorbs clock skew at the boundary.
 */
export function createInboundChatBucket(now: number = Date.now()): TokenBucket {
  return new TokenBucket(
    CHAT_RATE.capacity + INBOUND_CHAT_GRACE,
    CHAT_RATE.refillMs,
    now,
  );
}
