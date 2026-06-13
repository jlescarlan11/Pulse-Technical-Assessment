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
 * We test observable text/roles, not internals. jsdom is scoped via the
 * docblock so the node-env unit/API suites are unaffected.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ChatPanel, { type ChatMessage } from "./ChatPanel";
import { callSign } from "@/lib/callsign";

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
