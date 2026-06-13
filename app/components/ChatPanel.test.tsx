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
 * We test observable text/roles, not internals. jsdom is scoped via the
 * docblock so the node-env unit/API suites are unaffected.
 */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import ChatPanel, { type ChatMessage } from "./ChatPanel";

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
