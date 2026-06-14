/**
 * @jest-environment jsdom
 *
 * ChatPanel — Delivery Echo (the honest per-message delivery indicator).
 *
 * Behaviour under test (observable text / roles, never internals):
 *   - An outbound (mine) message renders "Sent" at rest (the CALM, COMPLETE
 *     default — not "pending") and, once its `delivered` flips true, renders
 *     "Delivered". Sent vs Delivered is icon + text; there is NO spinner /
 *     progressbar (the indicator never implies an in-flight wait).
 *   - Incoming (mine:false) messages carry NEITHER label — the indicator is for
 *     OUR messages only.
 *   - A polite sr-only live region announces "Message delivered" exactly when
 *     the delivered count RISES (a real ack landed). A message resting at "Sent"
 *     never announces; a re-render that doesn't raise the delivered count (an
 *     idempotent ack, an unrelated prop change) does NOT re-announce.
 *
 * HONESTY HARD LINES (the stakeholder's non-negotiables, asserted directly):
 *   - The copy is exactly "Delivered" — never "Read" or "Seen", anywhere.
 *   - There is NO timeout-to-delivered: advancing timers must NOT flip a Sent
 *     message to Delivered. An ack (a real `delivered` prop) is the SOLE path.
 *
 * jsdom is scoped via the docblock so node-env suites are unaffected. We reuse
 * the same scrollTo stub + panel() helper shape as ChatPanel.test.tsx.
 */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import ChatPanel, { type ChatMessage } from "./ChatPanel";

// jsdom doesn't implement Element.scrollTo; ChatPanel's auto-scroll effect
// calls it on the message list. Stub it as a no-op.
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

// A fixed origin so Fade Trails math (age = now − createdAt) is deterministic;
// createdAt is "now" so bubbles render fresh and nothing depends on real time.
const NOW = 1_700_000_000_000;

function mine(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 1, mine: true, text: "my message", createdAt: NOW, ...over };
}
function incoming(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 2, mine: false, text: "their message", createdAt: NOW, ...over };
}

// --- AC7: undelivered outbound -> "Sent", not "Delivered", no spinner -------

describe("ChatPanel Delivery Echo — Sent (resting) state", () => {
  it("an outbound message with delivered falsy renders 'Sent' and NOT 'Delivered'", () => {
    renderPanel({ messages: [mine({ delivered: false })] });

    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });

  it("an outbound message with delivered undefined (the default) also renders 'Sent'", () => {
    renderPanel({ messages: [mine()] });

    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });

  it("the resting indicator is NOT a spinner/progressbar — it implies no in-flight wait", () => {
    renderPanel({ messages: [mine({ delivered: false })] });

    // "Sent" is a complete state; there is no loading affordance.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { busy: true })).not.toBeInTheDocument();
  });
});

// --- AC8: delivered outbound -> "Delivered" ---------------------------------

describe("ChatPanel Delivery Echo — Delivered state", () => {
  it("an outbound message with delivered:true renders 'Delivered' (not 'Sent')", () => {
    renderPanel({ messages: [mine({ delivered: true })] });

    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
  });

  it("HONESTY: the delivered copy is exactly 'Delivered' — never 'Read' or 'Seen'", () => {
    renderPanel({ messages: [mine({ delivered: true })] });

    expect(screen.getByText("Delivered")).toBeInTheDocument();
    // The over-promising read-receipt language is forbidden everywhere.
    expect(screen.queryByText(/Read/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Seen/i)).not.toBeInTheDocument();
  });
});

// --- AC9: incoming messages carry neither label -----------------------------

describe("ChatPanel Delivery Echo — incoming messages have no indicator", () => {
  it("an incoming (mine:false) message renders NEITHER 'Sent' nor 'Delivered'", () => {
    renderPanel({ messages: [incoming()] });

    expect(screen.getByText("their message")).toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });

  it("a delivered flag on an incoming message is still not shown (indicator is mine-only)", () => {
    // Even if the data carried a stray delivered flag on an incoming line, the
    // indicator is gated on m.mine, so neither label appears.
    renderPanel({ messages: [incoming({ delivered: true })] });

    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });
});

// --- AC10: polite live-region announcement on the delivered transition ------

describe("ChatPanel Delivery Echo — polite 'Message delivered' announcement", () => {
  it("does NOT announce for a message resting at 'Sent'", () => {
    renderPanel({ messages: [mine({ delivered: false })] });

    // The live region exists but stays empty while nothing has been delivered.
    expect(screen.queryByText("Message delivered")).not.toBeInTheDocument();
  });

  it("announces 'Message delivered' when a message FLIPS from Sent to Delivered", () => {
    const before = [mine({ id: 1, delivered: false })];
    const { rerender } = renderPanel({ messages: before });
    expect(screen.queryByText("Message delivered")).not.toBeInTheDocument();

    // An ack lands: the same message id flips delivered -> true.
    act(() => {
      rerender(panel({ messages: [mine({ id: 1, delivered: true })] }));
    });

    expect(screen.getByText("Message delivered")).toBeInTheDocument();
    // And the visible bubble indicator agrees.
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });

  it("does NOT re-announce on an idempotent re-render where the delivered COUNT does not rise", () => {
    // Start already-delivered: the announcement reflects the count, which is 1
    // from the first render and must not re-fire just because we re-render with
    // the same delivered set (an idempotent/duplicate ack).
    const delivered = [mine({ id: 1, delivered: true })];
    const { rerender } = renderPanel({ messages: delivered });

    // Re-render with the SAME delivered count (e.g. an unrelated prop tick, or a
    // duplicate ack that didn't change anything). The count (1) does not rise…
    act(() => {
      rerender(panel({ messages: [mine({ id: 1, delivered: true })], peerTyping: true }));
    });

    // …so the polite region is not re-populated by this no-op transition.
    // (The first render's count rise of 0->1 is the only legitimate announce;
    // we assert no SPURIOUS announce on a count that merely holds steady.)
    expect(screen.queryByText("Message delivered")).not.toBeInTheDocument();
  });
});

// --- HONESTY: no timeout path to "Delivered" --------------------------------

describe("ChatPanel Delivery Echo — NO fake-advance to Delivered (honesty)", () => {
  it("advancing timers does NOT flip a Sent message to Delivered (an ack is the sole path)", () => {
    jest.useFakeTimers();
    try {
      // A live, unacked outbound message. The Fade Trails shared ticker and any
      // other timers run, but none of them may invent a delivery.
      renderPanel({ messages: [mine({ delivered: false })] });

      expect(screen.getByText("Sent")).toBeInTheDocument();

      act(() => {
        // Advance far past any plausible UI timeout (Fade Trails decay is 90s).
        jest.advanceTimersByTime(120_000);
      });

      // Still "Sent". No timer fabricated a "Delivered" — only a real ack
      // (a delivered prop flip) may do that.
      expect(screen.getByText("Sent")).toBeInTheDocument();
      expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
      expect(screen.queryByText("Message delivered")).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
