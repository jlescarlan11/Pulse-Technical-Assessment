"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { peerColor } from "@/lib/peerColor";
import { callSign } from "@/lib/callsign";
import { createChatBucket, type TokenBucket } from "@/lib/chatRate";

export interface ChatMessage {
  id: number;
  mine: boolean;
  text: string;
  /**
   * Client-only wall-clock creation stamp (Date.now(), ms epoch), set in
   * page.tsx#addMessage. Drives the Fade Trails visual decay below and nothing
   * else — it is never sent over the wire, never persisted, and does not change
   * a message's real (in-memory, teardown-cleared) lifetime.
   */
  createdAt: number;
  /**
   * Delivery Echo: only meaningful for `mine: true` messages. Undefined/false =
   * "Sent" (the CALM, COMPLETE resting default — not pending). Flipped to true
   * by page.tsx#onDelivered ONLY when a real ack for this id arrives over the
   * data channel. There is intentionally NO "undeliverable" state (cut), and
   * NO timeout-to-delivered: an ack is the sole path to true. Honest meaning =
   * "reached the peer's client", never "read"/"seen".
   */
  delivered?: boolean;
}

// Throttle for outbound onTyping(true): once we've told the peer we're typing
// we hold off re-announcing for this long, so a burst of keystrokes is a single
// signal rather than one per key.
const TYPING_THROTTLE_MS = 1500;
// Idle window: if no keystroke lands within this long, we tell the peer we've
// stopped typing.
const TYPING_IDLE_MS = 2500;
// Minimum time the send cooldown stays visible once armed, so a near-instant
// refill doesn't flash the notice as a perceived glitch (and the aria-live
// line isn't clipped for screen readers). The actual wait is whichever of this
// and the real refill estimate is longer.
const COOLDOWN_MIN_MS = 700;

// ── Fade Trails (visual decay) ──
// A message dims with AGE so the "nothing is kept" promise is FELT, not just
// told. This is PURELY VISUAL: opacity only. The text node is never removed,
// never aria-hidden, never display:none'd — the accessibility tree stays at
// full fidelity at every stage, and the real (in-memory, teardown-cleared)
// lifetime is untouched. Honesty guardrail: the floor is ABOVE zero, so the
// fade can never imply a deletion that isn't happening — a dimmed line is still
// plainly there, because it still is.
//
// Opacity falls monotonically from FULL to FLOOR over DECAY_MS as a function of
// age = now − createdAt, then RESTS at FLOOR forever. A gentle ease-out shapes
// the curve (calm, never abrupt); it stays monotonic so a message only ever
// dims, never brightens.
const DECAY_FULL_OPACITY = 1;
const DECAY_FLOOR_OPACITY = 0.35;
// S4 — PER-STYLE floor for INCOMING bubbles. Measured WCAG contrast: the "mine"
// bubble is an OPAQUE signal fill (the map can't bleed through) so it stays
// readable, but the incoming bubble (text-haze-100 #e1e7f5 on bg-ink-750/80
// #121a30 at 80% over the translucent .glass panel) composited at the 0.35 floor
// measures only ~2.7:1 — BELOW AA 4.5:1. Raising the incoming floor to 0.55
// lifts the composited text to ~4.8–5.0:1 across the realistic backdrop range
// (dark map → light label) while still reading as a clear, honest dim. Mine keeps
// the deeper 0.35 floor since its contrast is intrinsic, not background-coupled.
const DECAY_FLOOR_OPACITY_INCOMING = 0.55;
const DECAY_MS = 90_000; // age at which a message reaches the resting floor
// Shared-ticker cadence. ONE interval re-renders the whole list so every
// bubble's opacity recomputes from its own age — we never run a timer/rAF per
// message (the perf guardrail). ~1s is imperceptibly smooth for a 90s fade and
// far cheaper than a 60fps rAF loop for a handful of static text nodes.
const DECAY_TICK_MS = 1000;

// Reduced-motion cadence. The stepped path only needs to catch ONE threshold
// crossing (the midpoint, FULL→FLOOR), so we tick far more slowly than the
// smooth path — just often enough that the single calm step lands promptly,
// without a busy timer. Coarser cadence = fewer wakeups for the same result.
const DECAY_REDUCED_TICK_MS = 5000;

// Pure age→opacity mapping. Clamps age into [0, DECAY_MS], applies a gentle
// ease-out (1 − (1−t)^2), and lerps FULL→FLOOR. At age 0 → FULL; at age ≥
// DECAY_MS → FLOOR. No clock, no state — just math, so it's trivially testable
// and identical on every render.
function decayOpacity(ageMs: number, floor: number = DECAY_FLOOR_OPACITY): number {
  const t = Math.min(Math.max(ageMs, 0), DECAY_MS) / DECAY_MS;
  const eased = 1 - (1 - t) * (1 - t); // ease-out: quick-ish settle, calm tail
  // S4 — the resting floor is per-style (incoming uses a higher AA-legible floor).
  return DECAY_FULL_OPACITY - eased * (DECAY_FULL_OPACITY - floor);
}

// Reduced-motion STATIC step. Under prefers-reduced-motion we must NOT run a
// continuous opacity loop, so each bubble renders a single, stable,
// age-appropriate opacity: FULL while the line is recent, then one calm step to
// the resting FLOOR once it has aged past the midpoint. This maps age to one of
// only TWO values, so the shared ticker (which still runs, to advance `now`)
// can at most produce a single instantaneous opacity step at the midpoint —
// never a continuous/animated transition. That discrete one-time step is what
// prefers-reduced-motion permits and is exactly what the spec asked for.
const DECAY_REDUCED_STEP_MS = DECAY_MS / 2;
function staticDecayOpacity(
  ageMs: number,
  floor: number = DECAY_FLOOR_OPACITY,
): number {
  // S4 — the single calm step lands on the per-style floor (incoming = higher).
  return ageMs < DECAY_REDUCED_STEP_MS ? DECAY_FULL_OPACITY : floor;
}

// Live read of the OS/browser reduced-motion preference. JS-driven decay (the
// shared ticker) is invisible to the globals.css reduced-motion block — that
// only governs CSS animations/transitions — so we branch on it MANUALLY, the
// same pattern WorldMap.tsx uses for its JS camera moves. Read at mount/effect
// time; SSR-guarded for the (never, here) absent-matchMedia case.
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function ChatPanel({
  messages,
  connected,
  videoBusy,
  onSend,
  onStartVideo,
  onEnd,
  onBlock,
  peerId,
  peerTyping,
  onTyping,
}: {
  messages: ChatMessage[];
  connected: boolean;
  videoBusy: boolean;
  onSend: (text: string) => void;
  onStartVideo: () => void;
  onEnd: () => void;
  /**
   * Refuse this peer for the rest of the session and return to the map.
   * Single-tap (no confirm) — Undo lives in the resulting toast. Available
   * whenever the panel is mounted (connecting OR connected), same as onEnd.
   */
  onBlock: () => void;
  peerId?: string;
  /** true while the stranger is composing a message. */
  peerTyping: boolean;
  /** Tell the peer we started (true) or stopped (false) typing. */
  onTyping: (isTyping: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [slowConnect, setSlowConnect] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Outbound-typing bookkeeping, all in refs so the throttle/idle logic never
  // triggers a re-render:
  //   - lastTrueAt: when we last fired onTyping(true), for the throttle.
  //   - idleTimer:  the pending onTyping(false) fired after a typing pause.
  //   - sentTrue:   whether the peer currently believes we're typing, so we
  //                 don't spam matching onTyping(false) calls.
  //   - onTypingRef: latest onTyping, so the stable callbacks below can call it
  //                 without re-subscribing to every prop change.
  const lastTrueAt = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTrue = useRef(false);
  const onTypingRef = useRef(onTyping);
  useEffect(() => {
    onTypingRef.current = onTyping;
  }, [onTyping]);

  // Outbound chat send cooldown (UX honesty layer). We track our OWN send
  // rate against the SAME shared limit the peer clamps inbound with
  // (lib/chatRate.ts), so a compliant client never silently overruns a
  // compliant peer. The bucket itself lives in a ref — spending a token must
  // not re-render. Only the boolean `coolingDown` is state, and it flips just
  // twice per burst (at-limit -> disabled, refill -> enabled), mirroring the
  // ref-based typing throttle above. We do NOT queue messages: queueing would
  // imply a persistence we don't have and would hide the at-limit state.
  const sendBucket = useRef<TokenBucket | null>(null);
  const reenableTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [coolingDown, setCoolingDown] = useState(false);

  // Keep the latest message in view by scrolling the list itself — never the
  // page — so the drawer can't shift the surrounding layout. The typing
  // indicator is part of the same scroll container, so it re-runs when the
  // peer starts/stops typing too and the bubble stays visible.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, peerTyping, connected]);

  // If the channel hasn't opened after a few seconds, surface a gentle
  // "taking longer" hint so the connecting state is never a silent dead end.
  // Purely presentational — the connection lifecycle itself is unchanged.
  // (The status line still reads "Connected" once `connected` flips, so this
  // flag only ever shows while disconnected.)
  useEffect(() => {
    if (connected) return;
    const t = setTimeout(() => setSlowConnect(true), 8000);
    return () => clearTimeout(t);
  }, [connected]);

  // Stop the idle timer and, if the peer thinks we're typing, retract it.
  // Used on submit, when the draft empties, when the connection drops, and on
  // unmount. Reads onTyping via the ref so it's stable across renders.
  const stopTyping = useCallback(() => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (sentTrue.current) {
      sentTrue.current = false;
      onTypingRef.current(false);
    }
    lastTrueAt.current = 0;
  }, []);

  // Clean up timers on unmount and tell the peer we're no longer typing.
  useEffect(() => {
    return () => {
      stopTyping();
      if (reenableTimer.current) clearTimeout(reenableTimer.current);
    };
  }, [stopTyping]);

  // ── Fade Trails shared ticker ──
  // A SINGLE interval (not one timer per message) bumps `now` so the message
  // list re-renders and every bubble's opacity recomputes from its own age. We
  // store `now` in state purely as a render driver — the opacities themselves
  // are derived (decayOpacity), never stored.
  //
  // Reduced motion: we branch MANUALLY (the loop is JS, invisible to the
  // globals.css reduced-motion block). The ticker still runs so `now` keeps
  // advancing — `reduceMotion` selects only WHICH opacity fn render uses
  // (stepped staticDecayOpacity vs smooth decayOpacity), not whether time
  // advances. staticDecayOpacity returns one of only two values, so a running
  // ticker can at most produce ONE instantaneous FULL→FLOOR step at the
  // midpoint — a discrete state change, not an animation, which is exactly what
  // prefers-reduced-motion permits. We do tick more slowly in that mode (one
  // crossing to catch, not a smooth fade). `reduceMotion` is read once at mount
  // via state initialiser so the render branch and the effect agree.
  //
  // Clock basis: wall-clock age (now − createdAt), so a message keeps aging
  // even while the tab is hidden — we deliberately do NOT pause on
  // visibilitychange (cheaper, and more honest: time really did pass).
  //
  // Lifecycle: the interval is cleared on unmount, mirroring the timer-cleanup
  // discipline above — no ticker leak after teardown() unmounts the panel.
  const [reduceMotion] = useState(prefersReducedMotion);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Nothing aging to drive a repaint for? Skip the interval until there is.
    if (messages.length === 0) return;
    // Coarser cadence under reduced motion: one midpoint crossing to catch,
    // not a continuous fade. Mode picks the cadence here and the opacity fn in
    // render; it never decides whether `now` advances.
    const tick = reduceMotion ? DECAY_REDUCED_TICK_MS : DECAY_TICK_MS;
    const id = setInterval(() => setNow(Date.now()), tick);
    return () => clearInterval(id);
  }, [reduceMotion, messages.length]);

  // Delivery Echo (Story E): honest, POLITE screen-reader announcement when one
  // of OUR messages becomes Delivered. We watch the count of delivered outbound
  // messages; when it rises (an ack just landed) we set a short live-region
  // string. Copy is strictly "Message delivered" — never "Read"/"Seen", and a
  // message resting at Sent never announces (the count only rises on a real
  // ack-driven delivered flip). Idempotent acks don't change the count, so they
  // never re-announce. The region itself is the visually-hidden node below.
  const deliveredCount = messages.reduce(
    (n, m) => (m.mine && m.delivered ? n + 1 : n),
    0,
  );
  const prevDeliveredCount = useRef(deliveredCount);
  const [deliveryAnnounce, setDeliveryAnnounce] = useState("");
  useEffect(() => {
    if (deliveredCount > prevDeliveredCount.current) {
      setDeliveryAnnounce("Message delivered");
    }
    prevDeliveredCount.current = deliveredCount;
  }, [deliveredCount]);

  function onDraftChange(next: string) {
    setDraft(next);

    // Never announce typing when there's no open channel to carry it.
    if (!connected) return;

    if (next.trim() === "") {
      // Cleared the field — retract any in-flight "typing" immediately.
      stopTyping();
      return;
    }

    // Throttle the outbound true: only re-announce if it's been a while since
    // the last one (or we've never announced this run).
    const now = Date.now();
    if (!sentTrue.current || now - lastTrueAt.current >= TYPING_THROTTLE_MS) {
      sentTrue.current = true;
      lastTrueAt.current = now;
      onTyping(true);
    }

    // (Re)start the idle countdown — a pause longer than the window retracts.
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      idleTimer.current = null;
      if (sentTrue.current) {
        sentTrue.current = false;
        onTypingRef.current(false);
      }
      lastTrueAt.current = 0;
    }, TYPING_IDLE_MS);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !connected || coolingDown) return;

    // Spend a token against our own outbound budget before sending. Built
    // lazily so a session that never sends pays nothing. If the bucket is
    // empty we arm the cooldown and bail WITHOUT sending or clearing the
    // draft, so the message isn't lost — the user simply waits a beat.
    if (!sendBucket.current) sendBucket.current = createChatBucket();
    if (!sendBucket.current.tryRemove()) {
      armCooldown();
      return;
    }

    onSend(text);
    setDraft("");
    // The message is on its way — we're no longer "typing".
    stopTyping();

    // If that send drained the last token, disable the composer until a
    // token refills, then auto-re-enable. This keeps outbound capacity in
    // lockstep with the peer's inbound clamp.
    if (!sendBucket.current.hasCapacity()) armCooldown();
  }

  // Enter the cooldown and schedule the exact auto-re-enable. Idempotent: a
  // second call just reschedules against the latest refill estimate.
  function armCooldown() {
    const bucket = sendBucket.current;
    if (!bucket) return;
    const refillWait = bucket.msUntilNext();
    if (refillWait <= 0) {
      setCoolingDown(false);
      return;
    }
    // Hold the notice for a readable minimum even if a token refills sooner.
    const wait = Math.max(refillWait, COOLDOWN_MIN_MS);
    setCoolingDown(true);
    if (reenableTimer.current) clearTimeout(reenableTimer.current);
    reenableTimer.current = setTimeout(() => {
      reenableTimer.current = null;
      setCoolingDown(false);
    }, wait);
  }

  const accent =
    peerId !== undefined ? peerColor(peerId) : "var(--color-signal)";
  // The peer's ephemeral call-sign (this-session signal label, not a name).
  // Falls back to the neutral "Stranger" when there's no peer id yet.
  const signLabel = peerId !== undefined ? callSign(peerId) : "Stranger";

  // The incoming typing bubble only makes sense on a live channel.
  const showTyping = peerTyping && connected;

  return (
    <div className="animate-slide-in glass absolute inset-y-0 right-0 z-30 flex w-full max-w-md flex-col border-0 border-l text-haze-50">
      {/* Header */}
      <header className="hairline flex items-center justify-between border-b px-4 py-3.5">
        <div className="flex items-center gap-3">
          {/* Identity orb in the peer's colour */}
          <span
            className="relative flex h-9 w-9 items-center justify-center rounded-full text-ink-950"
            style={{
              background: `radial-gradient(circle at 35% 30%, #fff, ${accent} 78%)`,
              boxShadow: `0 0 16px -3px ${accent}`,
            }}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="8" r="3.4" fill="currentColor" />
              <path
                d="M5.5 19a6.5 6.5 0 0 1 13 0"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div>
            <p className="truncate font-semibold leading-tight tracking-tight">
              {signLabel}
            </p>
            <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-haze-400">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  connected ? "bg-signal shadow-glow-sm" : "animate-pulse bg-haze-400"
                }`}
              />
              {connected
                ? "Connected"
                : slowConnect
                  ? "Still connecting…"
                  : "Connecting…"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onStartVideo}
            disabled={!connected || videoBusy}
            title="Start video"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-haze-200/15 text-haze-200 transition hover:border-signal/50 hover:text-signal active:scale-90 disabled:opacity-35 disabled:hover:border-haze-200/15 disabled:hover:text-haze-200"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="3" y="6" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="M15 10.5l5-2.8v8.6l-5-2.8" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            </svg>
          </button>
          {/* Divider: sets the constructive control (video) apart from the
              destructive pair, so the row parses as "talk more │ leave". */}
          <span aria-hidden className="mx-0.5 h-5 w-px rounded-full bg-haze-200/15" />
          {/* Danger pair (Story 3 AC1 + Phase 4): two escalating, LABELED
              actions, both COOLED at rest so the header never reads as
              aggressive while the conversation is healthy. Severity is still
              encoded by WEIGHT — but the weight now reveals on hover/intent
              rather than shouting by default. Both carry a visible word so the
              more deliberate control never reads as less deliberate than the
              lighter one.

              "End chat" — the GREATER end-action (ends the whole conversation,
              heavier sibling of VideoPanel's "End video") yet the LIGHTER of
              this pair. At rest it is NEUTRAL — a quiet hairline ghost, no red —
              because ending a chat is graceful; you might meet this peer again.
              Hover warms it to a danger TINT, the gentle "this ends things" cue.

              "Block" — the MORE severe sibling. It is the only control wearing
              danger colour AT REST (a danger OUTLINE + the no-entry ring glyph,
              a conventional "blocked" mark — not the old shield-off metaphor
              that over-promised protection), so it always reads as the more
              deliberate action even before you touch it. Hover fills it to a
              solid danger PLATE with the signal-danger glow — its full weight,
              revealed on intent. Single-tap, no confirm modal — Undo lives in
              the resulting toast and receives focus there. The accessible name
              carries the peer call-sign; the title is a redundant honesty
              enhancement, NOT the sole carrier (the toast's "for this session"
              copy is the persistent, reachable reinforcement of the
              session-scoped ceiling). :focus-visible inherits the global signal
              ring; reduced-motion collapses the active-scale via globals.css.
              whitespace-nowrap keeps both pills from wrapping when all three
              controls share the header. */}
          <button
            onClick={onEnd}
            title="End conversation"
            className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-haze-200/15 px-3.5 text-sm font-medium text-haze-200 transition hover:border-danger/30 hover:bg-danger/15 hover:text-danger-400 active:scale-95"
          >
            End chat
          </button>
          <button
            onClick={onBlock}
            aria-label={`Block ${signLabel} for this session`}
            title={`Block ${signLabel} — they vanish from your map and can't reconnect this session. They reappear if they reload (new identity).`}
            className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-danger/40 bg-danger/5 px-3.5 text-sm font-semibold text-danger-400 transition hover:border-danger hover:bg-danger hover:text-white hover:shadow-[0_0_16px_-4px_var(--color-danger)] active:scale-95"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M6.4 6.4l11.2 11.2"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            Block
          </button>
        </div>
      </header>

      {/* Messages */}
      <div ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-5">
        {/* FIX 3 (M4) — the empty message area has two distinct calm states so
            the body never contradicts the composer:
              - NOT connected (handshake): a quiet connecting-specific state
                that matches the header "Connecting…/Still connecting…" status
                and the disabled "Connecting…" composer. No "Say hello." while
                you can't type yet.
              - connected, no messages: the real "Say hello." empty state.
            Both are gated on messages.length === 0. aria-live=polite so a
            screen reader hears the body settle from connecting to ready without
            stealing focus; reduced-motion users get the same static layout
            (globals.css collapses the fade).

            PHASE-4 REFINEMENT — when the thread is still empty AND the peer has
            started composing the very first message (showTyping), the big
            centred "Say hello." block yields to the typing indicator below so
            the two don't compete for space. The connected empty state is gated
            on !showTyping for exactly that reason; the bubble then reads
            naturally as the stranger writing the opener. The NOT-connected
            connecting body is unaffected (showTyping is false while
            disconnected). */}
        {messages.length === 0 &&
          (connected ? (
            !showTyping && (
              <div
                role="status"
                aria-live="polite"
                className="animate-fade-up mt-10 flex flex-col items-center gap-3 px-6 text-center"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-700/60 text-signal">
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9l-4 4v-4H6.5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <p className="text-sm font-medium text-haze-200">Say hello.</p>
                <p className="max-w-[15rem] text-xs leading-relaxed text-haze-500">
                  Messages travel peer-to-peer and are never stored. When the tab
                  closes, the conversation is gone.
                </p>
              </div>
            )
          ) : (
            <div
              role="status"
              aria-live="polite"
              className="animate-fade-up mt-10 flex flex-col items-center gap-3 px-6 text-center"
            >
              {/* Quiet connecting state: a steady haze dot (icon + text, not
                  colour alone) that mirrors the header status. The pulse is
                  animate-pulse, which globals.css holds steady at full opacity
                  under prefers-reduced-motion. */}
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-700/60 text-haze-300">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-haze-400" />
              </span>
              <p className="text-sm font-medium text-haze-300">
                {slowConnect ? "Still connecting…" : "Connecting…"}
              </p>
              <p className="max-w-[15rem] text-xs leading-relaxed text-haze-500">
                Opening a private peer-to-peer channel. You can send a signal
                once it’s ready.
              </p>
            </div>
          ))}
        {messages.map((m, i) => {
          // Fade Trails: dim each bubble by AGE. Reduced motion gets a stable
          // static step (no loop); otherwise the shared ticker's `now` drives a
          // smooth fade toward the resting floor. Uniform for BOTH bubble
          // styles (mine = signal-fill, incoming = hairline-ink); the floor
          // (0.35) stays legible against the panel for both.
          //
          // The NEWEST message (last in the list) is pinned to FULL opacity so
          // the active line of conversation is always the most legible,
          // regardless of its computed age. Older lines are dimmer — and since
          // decayOpacity is monotonic in age and the list is append-only in
          // creation order, newest ≥ older holds.
          //
          // We set opacity via inline style (not a CSS transition) so it cannot
          // fight the animate-msg-in entrance: the entrance plays on the wrapper
          // div, the decay rides the inner span, and a fresh bubble starts at
          // FULL (age ≈ 0) so the two never visibly contend.
          const isNewest = i === messages.length - 1;
          const ageMs = now - m.createdAt;
          // S4 — incoming bubbles rest at a higher floor so their text stays AA-
          // legible over the translucent panel; mine keeps the deeper 0.35 floor
          // (its contrast is intrinsic to the opaque signal fill). Newest stays
          // pinned to FULL and the reduced-motion stepped path is unchanged in
          // shape — both just inherit the per-style floor.
          const floor = m.mine
            ? DECAY_FLOOR_OPACITY
            : DECAY_FLOOR_OPACITY_INCOMING;
          const opacity = isNewest
            ? DECAY_FULL_OPACITY
            : reduceMotion
              ? staticDecayOpacity(ageMs, floor)
              : decayOpacity(ageMs, floor);
          return (
            <div
              key={m.id}
              className={`animate-msg-in flex ${m.mine ? "justify-end" : "justify-start"}`}
            >
              <span
                // opacity only — the text stays in the DOM and the
                // accessibility tree at full fidelity at every decay stage.
                style={{ opacity }}
                className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                  m.mine
                    ? "rounded-br-md bg-signal font-medium text-ink-950 shadow-glow-sm"
                    : "hairline rounded-bl-md border bg-ink-750/80 text-haze-100"
                }`}
              >
                {m.text}
                {/* Delivery Echo (Story D): a QUIET resting indicator under our
                    own messages. Delivered-only — "Sent" is intentionally
                    implicit: at rest there is NO label (a bubble's mere presence
                    says "sent"), the calmest resting state and one that can't
                    read as "pending". Delivered is then a true additive upgrade:
                    a single subtle check glyph (no word), reading in muted ink
                    against the opaque signal fill so it stays legible even when
                    Fade Trails has dimmed the bubble (the indicator rides the
                    same decayed span). The check is a non-text mark (>3:1, fine);
                    a visually-hidden "Delivered" keeps the per-message state in
                    the a11y tree (honest meaning = "reached the peer's client",
                    never "read"/"seen") so screen-reader users aren't left with a
                    bare, unlabelled glyph. No motion of its own — the swap is an
                    instantaneous content change, reduced-motion-safe by
                    construction. */}
                {m.mine && m.delivered && (
                <span className="mt-1 flex items-center justify-end text-ink-950/80">
                  <svg
                    className="h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="m5 13 4 4L19 7"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="sr-only">Delivered</span>
                </span>
                )}
              </span>
            </div>
          );
        })}

        {/* Incoming typing indicator — a transient peer "message" pinned to the
            bottom of the list. It has NO message id (it isn't a real message),
            reuses the incoming-bubble shape (hairline / ink / flattened
            bottom-left), and carries three breathing dots in the peer's colour
            plus the call-sign line. role="status" + aria-live="polite" lets a
            screen reader announce that the peer is typing without stealing
            focus; the dots are aria-hidden so only the text conveys meaning.
            The dots use animate-pulse, which globals.css freezes at full
            opacity under prefers-reduced-motion (so they render as static
            dots). The staggered animationDelay gives a gentle wave when motion
            is allowed.

            When the thread is otherwise empty this bubble is the sole body
            content (the "Say hello." empty state yields to it above), so it
            still scrolls into view via the messages/peerTyping effect. */}
        {showTyping && (
          <div
            role="status"
            aria-live="polite"
            className="animate-msg-in flex justify-start"
          >
            <span className="hairline flex max-w-[80%] items-center gap-2 rounded-2xl rounded-bl-md border bg-ink-750/80 px-3.5 py-2.5">
              <span className="flex items-center gap-1" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
                    style={{
                      backgroundColor: accent,
                      animationDelay: `${i * 180}ms`,
                    }}
                  />
                ))}
              </span>
              <span className="text-xs leading-none text-haze-300">
                {signLabel} is typing…
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Delivery Echo (Story E): dedicated visually-hidden POLITE live region
          for the honest "Message delivered" announcement. Separate from the
          existing status regions so a delivery ack never collides with the
          connecting/cooldown/typing copy. aria-live=polite (not assertive)
          waits for a pause and never steals focus; the node is sr-only so it's
          screen-reader-only, matching the visual indicator on the bubble. */}
      <p role="status" aria-live="polite" className="sr-only">
        {deliveryAnnounce}
      </p>

      {/* Composer */}
      <form onSubmit={submit} className="hairline border-t p-3">
        {/* Cooldown notice (Story 2): when we've hit our own send budget only
            SENDING pauses — the input stays live so you can keep composing your
            next line and never lose focus mid-flow. We auto-re-enable as a token
            refills. The voice is system-state ("catching up"), not a scolding
            "slow down", to stay honest about what's happening: the channel is
            recovering, the user isn't at fault. role=status + aria-live=polite
            announces it without stealing focus; it fades in via animate-fade-up
            (held steady under prefers-reduced-motion by globals.css). No status
            dot — the connecting state owns the pulsing-haze-dot vocabulary, and
            this is a *connected* state, so text alone carries the meaning. */}
        {coolingDown && (
          <p
            role="status"
            aria-live="polite"
            className="animate-fade-up mb-2 px-1 text-xs text-haze-400"
          >
            Catching up — send resumes in a moment.
          </p>
        )}
        <div className="flex gap-2">
        {/* The input stays enabled during cooldown — only SEND is gated (the
            submit guard + disabled button below). Disabling a focused input
            would drop focus to <body> and never restore it, ejecting an
            actively-typing user from the composer. Keeping it live lets them
            keep drafting their next line while send briefly pauses. */}
        <input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder={!connected ? "Connecting…" : "Send a signal…"}
          disabled={!connected}
          aria-busy={coolingDown}
          className="flex-1 rounded-full border border-haze-200/10 bg-ink-900/70 px-4 py-2.5 text-sm text-haze-50 outline-none transition placeholder:text-haze-500 focus:border-signal/40 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!connected || !draft.trim() || coolingDown}
          title={coolingDown ? "Catching up — send resumes in a moment" : "Send"}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-signal text-ink-950 shadow-glow-sm transition duration-300 ease-[var(--ease-spring)] hover:scale-105 hover:shadow-glow active:scale-90 disabled:scale-100 disabled:opacity-35 disabled:shadow-none"
        >
          <svg className="h-4 w-4 rotate-45" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
        </button>
        </div>
      </form>
    </div>
  );
}
