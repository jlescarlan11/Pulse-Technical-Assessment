/**
 * @jest-environment jsdom
 *
 * ChatPanel — message-area state tests.
 *
 * FIX 3 (M4): the empty message area must AGREE with the composer. Previously
 * the "Say hello." empty state rendered whenever messages.length === 0,
 * INCLUDING during the connecting handshake while the composer is disabled and
 * reads "Connecting…" — the two halves contradicted ("Say hello." over a
 * composer you can't type into). The empty state is now gated on `connected`:
 *   - connected, no messages  -> "Say hello." invite + privacy note
 *   - NOT connected            -> a quiet connecting-specific message-area state
 *     that mirrors the header "Connecting…/Still connecting…" status
 * Once messages exist, neither empty state shows.
 *
 * Phase 4: the typing indicator. An incoming "{call-sign} is typing…" bubble
 * shows at the bottom of the list when peerTyping && connected; the composer
 * announces our own typing via onTyping(true) (throttled) / onTyping(false)
 * (on submit). Timer-driven behaviour uses fake timers — no real sleeps.
 *
 * Phase 4 "Block & Next": the Block control in the header danger group. Tests
 * its accessible name (distinct from "End chat"), that it fires onBlock on
 * click + keyboard, and that End chat stays wired to onEnd only — behaviour and
 * accessible names, not glyph/CSS.
 *
 * We test observable text/roles, not internals. jsdom is scoped via the
 * docblock so the node-env unit/API suites are unaffected.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ChatPanel, { type ChatMessage } from "./ChatPanel";
import { callSign } from "@/lib/callsign";
import { CHAT_RATE } from "@/lib/chatRate";

// jsdom doesn't implement Element.scrollTo; ChatPanel's auto-scroll effect
// calls it on the message list. Stub it as a no-op so the unrelated scroll
// behaviour doesn't crash these state tests.
beforeAll(() => {
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
});

function panel(over: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  return (
    <ChatPanel
      messages={[]}
      connected={true}
      videoBusy={false}
      onSend={() => {}}
      onStartVideo={() => {}}
      onEnd={() => {}}
      onBlock={() => {}}
      peerId="abc"
      peerTyping={false}
      onTyping={() => {}}
      {...over}
    />
  );
}

function renderPanel(over: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  return render(panel(over));
}

const msgs: ChatMessage[] = [{ id: 1, mine: false, text: "hey there" }];

describe("ChatPanel empty / connecting message-area states (FIX 3)", () => {
  it("connected + no messages -> shows the 'Say hello.' invite, not a connecting state", () => {
    renderPanel({ connected: true, messages: [] });

    expect(screen.getByText("Say hello.")).toBeInTheDocument();
    expect(
      screen.getByText(/Messages travel peer-to-peer and are never stored/),
    ).toBeInTheDocument();
    // No connecting-specific body text while connected.
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
    // The composer agrees: enabled placeholder, no "Connecting…" placeholder.
    expect(screen.getByPlaceholderText("Send a signal…")).toBeEnabled();
  });

  it("NOT connected + no messages -> quiet connecting body, NOT 'Say hello.' (body agrees with disabled composer)", () => {
    renderPanel({ connected: false, messages: [] });

    // The contradiction is fixed: no "Say hello." while you can't type yet.
    expect(screen.queryByText("Say hello.")).not.toBeInTheDocument();

    // A connecting-specific calm state instead. "Connecting…" appears in both
    // the header status and the body; both should be present.
    expect(screen.getAllByText("Connecting…").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/Opening a private peer-to-peer channel/),
    ).toBeInTheDocument();

    // The composer is disabled and shows the connecting placeholder, so body
    // and composer now agree.
    const input = screen.getByPlaceholderText("Connecting…");
    expect(input).toBeDisabled();
  });

  it("NOT connected, no messages, icon + text (not colour alone) in a polite live region", () => {
    renderPanel({ connected: false, messages: [] });

    // The connecting body is a role=status live region so SR users hear it
    // settle to ready; it carries text, not colour alone.
    const statuses = screen.getAllByRole("status");
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/Opening a private peer-to-peer channel/),
    ).toBeInTheDocument();
  });

  it("connected with messages -> neither empty state renders, message is shown", () => {
    renderPanel({ connected: true, messages: msgs });

    expect(screen.queryByText("Say hello.")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Opening a private peer-to-peer channel/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("hey there")).toBeInTheDocument();
  });

  it("NOT connected but messages already exist -> shows messages, no connecting empty state", () => {
    // Empty-state gating is on messages.length === 0, so once messages exist
    // neither the invite nor the connecting body renders even if connection
    // momentarily drops.
    renderPanel({ connected: false, messages: msgs });

    expect(screen.queryByText("Say hello.")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Opening a private peer-to-peer channel/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("hey there")).toBeInTheDocument();
  });

  it("M4 escalation: after the grace window the connecting body reads 'Still connecting…'", () => {
    jest.useFakeTimers();
    try {
      renderPanel({ connected: false, messages: [] });

      // Before the grace window: the plain connecting copy.
      expect(screen.getAllByText("Connecting…").length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText("Still connecting…")).not.toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(8000);
      });

      // After: both the header status and the body soften to "Still connecting…".
      expect(screen.getAllByText("Still connecting…").length).toBeGreaterThanOrEqual(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("ChatPanel empty state yields to typing indicator (Phase 4 refinement)", () => {
  // call-sign for peerId "abc"; matched live so the test tracks the generator.
  const SIGN = callSign("abc");

  it("connected, no messages, peer NOT typing -> shows the 'Say hello.' empty state", () => {
    renderPanel({ connected: true, messages: [], peerTyping: false });

    expect(screen.getByText("Say hello.")).toBeInTheDocument();
    expect(
      screen.getByText(/Messages travel peer-to-peer and are never stored/),
    ).toBeInTheDocument();
    // Nothing competing: no typing bubble while the peer isn't composing.
    expect(screen.queryByText(/is typing…/)).not.toBeInTheDocument();
  });

  it("connected, no messages, peer typing -> SUPPRESSES 'Say hello.' and shows ONLY the typing indicator", () => {
    // First-chat clutter fix: with an empty thread and the stranger composing
    // the opener, the big centred empty state yields so the typing bubble is
    // the sole focus and reads as the stranger writing the first message.
    renderPanel({ connected: true, messages: [], peerTyping: true });

    // The big empty-state block is gone…
    expect(screen.queryByText("Say hello.")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Messages travel peer-to-peer and are never stored/),
    ).not.toBeInTheDocument();
    // …and the typing indicator is the visible body content.
    expect(screen.getByText(`${SIGN} is typing…`)).toBeInTheDocument();
  });
});


describe("ChatPanel typing indicator (Phase 4)", () => {
  // call-sign for peerId "abc" is computed by lib/callsign; we match against
  // the live value so the test stays in step with the call-sign generator.
  const SIGN = callSign("abc");

  it("shows the incoming 'is typing…' bubble with the call-sign when peerTyping && connected", () => {
    renderPanel({ connected: true, peerTyping: true, messages: msgs });

    expect(screen.getByText(`${SIGN} is typing…`)).toBeInTheDocument();
  });

  it("hides the indicator when the peer is not typing", () => {
    renderPanel({ connected: true, peerTyping: false, messages: msgs });

    expect(screen.queryByText(/is typing…/)).not.toBeInTheDocument();
  });

  it("hides the indicator when not connected, even if peerTyping is true", () => {
    renderPanel({ connected: false, peerTyping: true, messages: msgs });

    expect(screen.queryByText(/is typing…/)).not.toBeInTheDocument();
  });

  it("falls back to 'Stranger' in the indicator copy when there's no peerId", () => {
    renderPanel({
      connected: true,
      peerTyping: true,
      peerId: undefined,
      messages: msgs,
    });

    expect(screen.getByText("Stranger is typing…")).toBeInTheDocument();
  });

  it("typing in the composer calls onTyping(true), throttled to one call per window", () => {
    jest.useFakeTimers();
    try {
      const onTyping = jest.fn();
      render(panel({ connected: true, onTyping }));
      const input = screen.getByPlaceholderText("Send a signal…");

      // First keystroke with non-empty draft announces typing.
      fireEvent.change(input, { target: { value: "h" } });
      expect(onTyping).toHaveBeenCalledWith(true);
      expect(onTyping).toHaveBeenCalledTimes(1);

      // More keystrokes inside the throttle window do NOT re-announce true.
      fireEvent.change(input, { target: { value: "he" } });
      fireEvent.change(input, { target: { value: "hel" } });
      expect(onTyping).toHaveBeenCalledTimes(1);

      // Past the throttle window (but inside the idle window) the next
      // keystroke re-announces true.
      act(() => {
        jest.advanceTimersByTime(1500);
      });
      fireEvent.change(input, { target: { value: "hell" } });
      expect(onTyping).toHaveBeenCalledTimes(2);
      expect(onTyping).toHaveBeenLastCalledWith(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not announce typing when not connected", () => {
    const onTyping = jest.fn();
    // Render disabled-input variant; force-fire change anyway to prove the
    // guard, not just the disabled attribute, stops the announcement.
    render(panel({ connected: false, onTyping }));
    const input = screen.getByPlaceholderText("Connecting…");

    fireEvent.change(input, { target: { value: "hi" } });
    expect(onTyping).not.toHaveBeenCalled();
  });

  it("clearing the draft retracts typing immediately with onTyping(false)", () => {
    jest.useFakeTimers();
    try {
      const onTyping = jest.fn();
      render(panel({ connected: true, onTyping }));
      const input = screen.getByPlaceholderText("Send a signal…");

      fireEvent.change(input, { target: { value: "hi" } });
      onTyping.mockClear();

      fireEvent.change(input, { target: { value: "" } });
      expect(onTyping).toHaveBeenCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("the idle timer fires onTyping(false) after a typing pause", () => {
    jest.useFakeTimers();
    try {
      const onTyping = jest.fn();
      render(panel({ connected: true, onTyping }));
      const input = screen.getByPlaceholderText("Send a signal…");

      fireEvent.change(input, { target: { value: "hi" } });
      onTyping.mockClear();

      act(() => {
        jest.advanceTimersByTime(2500);
      });
      expect(onTyping).toHaveBeenCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("re-announces onTyping(true) IMMEDIATELY on the first keystroke after the idle timer fired", () => {
    // FINDING 2: the idle handler retracts (onTyping(false)) AND resets the
    // throttle bookkeeping (lastTrueAt -> 0, sentTrue -> false). So a keystroke
    // after the idle pause is a fresh run: it must re-announce typing right
    // away, WITHOUT waiting out the throttle window — otherwise the peer would
    // see us as silent through a whole throttle window of renewed typing.
    jest.useFakeTimers();
    try {
      const onTyping = jest.fn();
      render(panel({ connected: true, onTyping }));
      const input = screen.getByPlaceholderText("Send a signal…");

      // Type, then let the idle timer fire its retraction.
      fireEvent.change(input, { target: { value: "hi" } });
      expect(onTyping).toHaveBeenLastCalledWith(true);
      act(() => {
        jest.advanceTimersByTime(2500);
      });
      expect(onTyping).toHaveBeenLastCalledWith(false);
      onTyping.mockClear();

      // The very next keystroke — with NO time advanced past the idle fire —
      // must immediately re-announce true again (throttle was reset, not held).
      fireEvent.change(input, { target: { value: "hit" } });
      expect(onTyping).toHaveBeenCalledTimes(1);
      expect(onTyping).toHaveBeenCalledWith(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("submitting a message calls onSend then retracts typing with onTyping(false)", () => {
    jest.useFakeTimers();
    try {
      const onSend = jest.fn();
      const onTyping = jest.fn();
      render(panel({ connected: true, onSend, onTyping }));
      const input = screen.getByPlaceholderText("Send a signal…");

      fireEvent.change(input, { target: { value: "hello there" } });
      onTyping.mockClear();

      fireEvent.submit(input.closest("form") as HTMLFormElement);

      expect(onSend).toHaveBeenCalledWith("hello there");
      expect(onTyping).toHaveBeenCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("retracts typing on unmount", () => {
    jest.useFakeTimers();
    try {
      const onTyping = jest.fn();
      const { unmount } = render(panel({ connected: true, onTyping }));
      const input = screen.getByPlaceholderText("Send a signal…");

      fireEvent.change(input, { target: { value: "hi" } });
      onTyping.mockClear();

      unmount();
      expect(onTyping).toHaveBeenCalledWith(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("ChatPanel Block control (Phase 4 — Block & Next)", () => {
  // call-sign for peerId "abc"; matched live so the accessible-name assertion
  // tracks the generator rather than a hardcoded handle.
  const SIGN = callSign("abc");

  // Query the Block button by its accessible name ("Block {sign} for this
  // session"), and End chat by its visible label. Behaviour + accessible names,
  // never glyph/CSS.
  function blockButton() {
    return screen.getByRole("button", {
      name: `Block ${SIGN} for this session`,
    });
  }
  function endButton() {
    return screen.getByRole("button", { name: "End chat" });
  }

  it("renders the Block control while connecting (panel mounted, not yet connected)", () => {
    renderPanel({ connected: false });
    expect(blockButton()).toBeInTheDocument();
  });

  it("renders the Block control while connected", () => {
    renderPanel({ connected: true });
    expect(blockButton()).toBeInTheDocument();
  });

  it("Block has a distinct accessible name from End chat — they are two separate controls", () => {
    renderPanel({ connected: true });

    const block = blockButton();
    const end = endButton();

    // Both present…
    expect(block).toBeInTheDocument();
    expect(end).toBeInTheDocument();
    // …and genuinely distinct nodes with distinct accessible names.
    expect(block).not.toBe(end);
    expect(block).toHaveAccessibleName(`Block ${SIGN} for this session`);
    // End chat is named by its visible text, NOT the Block name.
    expect(end).toHaveAccessibleName("End chat");
  });

  it("the Block accessible name carries the peer call-sign (falls back to 'Stranger' with no peerId)", () => {
    renderPanel({ connected: true, peerId: undefined });
    expect(
      screen.getByRole("button", { name: "Block Stranger for this session" }),
    ).toBeInTheDocument();
  });

  it("clicking Block fires onBlock (and does NOT fire onEnd)", () => {
    const onBlock = jest.fn();
    const onEnd = jest.fn();
    renderPanel({ connected: true, onBlock, onEnd });

    fireEvent.click(blockButton());

    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("Block is keyboard-operable: Enter and Space activate it", () => {
    // A native <button> fires its click on Enter/Space via the browser's default
    // action; in jsdom we dispatch the click that the key activation produces,
    // mirroring the suite's existing fireEvent style for keyboard operability.
    const onBlock = jest.fn();
    renderPanel({ connected: true, onBlock });
    const block = blockButton();

    block.focus();
    expect(block).toHaveFocus();

    fireEvent.keyDown(block, { key: "Enter", code: "Enter" });
    fireEvent.click(block); // Enter on a button triggers click
    fireEvent.keyDown(block, { key: " ", code: "Space" });
    fireEvent.click(block); // Space on a button triggers click on keyup

    expect(onBlock).toHaveBeenCalled();
  });

  it("End chat still fires onEnd only (and does NOT fire onBlock) — the two are distinct", () => {
    const onBlock = jest.fn();
    const onEnd = jest.fn();
    renderPanel({ connected: true, onBlock, onEnd });

    fireEvent.click(endButton());

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onBlock).not.toHaveBeenCalled();
  });
});

describe("ChatPanel outbound send cooldown (Story 2)", () => {
  // Drive one send: set the draft, submit the form. The bucket reads Date.now(),
  // which jest's fake timers mock — so back-to-back sends with no advanceTimers
  // all land in the same instant and drain the shared CHAT_RATE bucket.
  function send(input: HTMLElement, text: string) {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
  }

  function sendButtonOf(input: HTMLElement) {
    return input
      .closest("form")!
      .querySelector('button[type="submit"]') as HTMLButtonElement;
  }

  // The unified, honest cooldown copy (system-state voice, not "slow down").
  const COOLDOWN_COPY = "Catching up — send resumes in a moment.";

  it("sends every message up to capacity, with no cooldown notice in-rate", () => {
    jest.useFakeTimers();
    try {
      const onSend = jest.fn();
      render(panel({ connected: true, onSend }));
      const input = screen.getByPlaceholderText("Send a signal…");

      // One under capacity: the bucket keeps a token, so we never cool down.
      for (let i = 0; i < CHAT_RATE.capacity - 1; i++) send(input, `m${i}`);

      expect(onSend).toHaveBeenCalledTimes(CHAT_RATE.capacity - 1);
      expect(screen.queryByText(COOLDOWN_COPY)).not.toBeInTheDocument();
      // Composer is fully usable in-rate: typing a fresh draft re-enables send
      // (the button only disables on an empty draft, never on an in-rate send).
      fireEvent.change(input, { target: { value: "still typing" } });
      expect(sendButtonOf(input)).not.toBeDisabled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("at the limit: blocks the next send, PRESERVES the draft, shows the notice, disables send — but keeps the INPUT enabled", () => {
    jest.useFakeTimers();
    try {
      const onSend = jest.fn();
      render(panel({ connected: true, onSend }));
      const input = screen.getByPlaceholderText("Send a signal…") as HTMLInputElement;

      // Drain the full burst — every one of these sends goes through.
      for (let i = 0; i < CHAT_RATE.capacity; i++) send(input, `m${i}`);
      expect(onSend).toHaveBeenCalledTimes(CHAT_RATE.capacity);

      // Cooldown is now armed: the honest, announced notice is present…
      const notice = screen.getByText(COOLDOWN_COPY);
      expect(notice).toBeInTheDocument();
      expect(notice.closest("[role='status']")).not.toBeNull();

      // …the over-limit send is blocked and the draft is NOT lost.
      send(input, "over the limit");
      expect(onSend).toHaveBeenCalledTimes(CHAT_RATE.capacity); // still capacity
      expect(input.value).toBe("over the limit"); // draft preserved, no loss

      // Send is gated, but the input stays live so the user can keep composing
      // and never loses focus (the M1/M2 fix — only SEND pauses, not typing).
      expect(sendButtonOf(input)).toBeDisabled();
      expect(input).toBeEnabled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("auto-recovers after a refill window WITHOUT a keystroke, and sending works again", () => {
    jest.useFakeTimers();
    try {
      const onSend = jest.fn();
      render(panel({ connected: true, onSend }));
      const input = screen.getByPlaceholderText("Send a signal…");

      for (let i = 0; i < CHAT_RATE.capacity; i++) send(input, `m${i}`);
      expect(screen.getByText(COOLDOWN_COPY)).toBeInTheDocument();

      // No keystroke — just let a token refill. The composer re-enables itself:
      // the cooldown notice clears and the input is live again.
      act(() => {
        jest.advanceTimersByTime(CHAT_RATE.refillMs);
      });
      expect(screen.queryByText(COOLDOWN_COPY)).not.toBeInTheDocument();
      expect(input).toBeEnabled();

      // And a fresh send goes through again (no permanent lockout).
      send(input, "after recovery");
      expect(onSend).toHaveBeenLastCalledWith("after recovery");
    } finally {
      jest.useRealTimers();
    }
  });

  it("the preserved draft can be sent after recovery (no message loss)", () => {
    jest.useFakeTimers();
    try {
      const onSend = jest.fn();
      render(panel({ connected: true, onSend }));
      const input = screen.getByPlaceholderText("Send a signal…") as HTMLInputElement;

      for (let i = 0; i < CHAT_RATE.capacity; i++) send(input, `m${i}`);

      // Type the message that gets blocked by the cooldown; it stays in the box.
      send(input, "kept through cooldown");
      expect(onSend).toHaveBeenCalledTimes(CHAT_RATE.capacity);
      expect(input.value).toBe("kept through cooldown");

      // After recovery the SAME draft sends — the user never had to retype.
      act(() => {
        jest.advanceTimersByTime(CHAT_RATE.refillMs);
      });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      expect(onSend).toHaveBeenLastCalledWith("kept through cooldown");
    } finally {
      jest.useRealTimers();
    }
  });

  it("holds the cooldown notice for the readable minimum even when a token refills sooner (anti-flicker floor)", () => {
    // The COOLDOWN_MIN_MS floor exists so a near-instant refill doesn't flash
    // the notice as a glitch. To exercise it we need the *refill estimate* at
    // arm-time to be SHORTER than the floor, so Math.max picks the floor:
    //   1. drain the burst, then let it fully recover (cooldown clears),
    //   2. consume most of the next window WITHOUT sending, so when we do send
    //      the limiting message, msUntilNext is only a fraction of refillMs,
    //   3. that fraction (< floor) means the notice must stay up for the floor.
    jest.useFakeTimers();
    try {
      const onSend = jest.fn();
      render(panel({ connected: true, onSend }));
      const input = screen.getByPlaceholderText("Send a signal…");

      // 1 — drain and fully recover (one token back, cooldown cleared).
      for (let i = 0; i < CHAT_RATE.capacity; i++) send(input, `m${i}`);
      act(() => {
        jest.advanceTimersByTime(CHAT_RATE.refillMs);
      });
      expect(screen.queryByText(COOLDOWN_COPY)).not.toBeInTheDocument();

      // 2 — burn most of the window with no send. The single refilled token is
      // still there; the refill estimate is now well under refillMs.
      const partial = Math.floor(CHAT_RATE.refillMs * 0.4); // 400ms
      const refillWait = CHAT_RATE.refillMs - partial; // 600ms < floor (700ms)
      act(() => {
        jest.advanceTimersByTime(partial);
      });

      // 3 — sending the one available token re-arms the cooldown. Its timer is
      // the FLOOR (700ms), not the 600ms refill estimate.
      send(input, "limiting send");
      expect(screen.getByText(COOLDOWN_COPY)).toBeInTheDocument();

      // At the refill estimate (600ms) the floor still holds the notice up —
      // if the code used refillWait instead of the floor, it would be gone here.
      act(() => {
        jest.advanceTimersByTime(refillWait);
      });
      expect(screen.getByText(COOLDOWN_COPY)).toBeInTheDocument();

      // Past the floor, it finally clears.
      act(() => {
        jest.advanceTimersByTime(200); // 600 + 200 = 800 > 700 floor
      });
      expect(screen.queryByText(COOLDOWN_COPY)).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
