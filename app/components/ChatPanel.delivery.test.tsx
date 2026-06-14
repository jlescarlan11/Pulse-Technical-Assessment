/**
 * @jest-environment jsdom
 *
 * ChatPanel — Delivery Echo (the honest per-message delivery indicator).
 *
 * Model under test (observable text / roles, never internals):
 *   - The indicator (Sent → Delivered) appears ONLY under the NEWEST message
 *     when it is OURS (mine) and actually went out — the Messenger/iMessage
 *     convention. "Sent" = handed to an open channel (honest; never claimed for
 *     a no-op'd send on a closed channel). "Delivered" = a real ack arrived.
 *   - Last-only: an older mine message shows no indicator even if delivered, and
 *     once the PEER replies (newest message is theirs) the indicator hides
 *     entirely — their reply is itself proof of receipt.
 *   - Incoming (mine:false) messages never carry the indicator.
 *   - A polite live region announces "Message delivered" exactly when the
 *     delivered count RISES (a real ack landed) — independent of the visible
 *     last-only rule. An idempotent/no-op re-render does NOT re-announce.
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

// --- Sent state: newest mine + sent (not yet acked) -------------------------

describe("ChatPanel Delivery Echo — Sent state", () => {
  it("the newest mine message that has been sent (not delivered) renders 'Sent'", () => {
    renderPanel({ messages: [mine({ sent: true })] });

    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });

  it("a mine message that was NOT sent (closed channel, no-op) and not delivered shows NO label", () => {
    // sent + delivered both falsy: the send no-op'd, so we honestly claim
    // nothing — neither "Sent" nor "Delivered".
    renderPanel({ messages: [mine()] });

    expect(screen.getByText("my message")).toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });

  it("the Sent state is NOT a spinner/progressbar — it implies no in-flight wait", () => {
    renderPanel({ messages: [mine({ sent: true })] });

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { busy: true })).not.toBeInTheDocument();
  });
});

// --- Delivered state: newest mine + ack -------------------------------------

describe("ChatPanel Delivery Echo — Delivered state", () => {
  it("a sent message that is delivered renders 'Delivered' (not 'Sent')", () => {
    renderPanel({ messages: [mine({ sent: true, delivered: true })] });

    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
  });

  it("delivered shows even if `sent` was never recorded (delivered implies it arrived)", () => {
    renderPanel({ messages: [mine({ delivered: true })] });

    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });

  it("HONESTY: the delivered copy is exactly 'Delivered' — never 'Read' or 'Seen'", () => {
    renderPanel({ messages: [mine({ sent: true, delivered: true })] });

    expect(screen.getByText("Delivered")).toBeInTheDocument();
    // The over-promising read-receipt language is forbidden everywhere.
    expect(screen.queryByText(/Read/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Seen/i)).not.toBeInTheDocument();
  });
});

// --- Last-message-only: the indicator lives only under the newest mine line --

describe("ChatPanel Delivery Echo — shown only under the newest message", () => {
  it("an older delivered mine message shows NO indicator; only the newest mine line does", () => {
    renderPanel({
      messages: [
        mine({ id: 1, text: "older", sent: true, delivered: true }),
        mine({ id: 2, text: "newest", sent: true }),
      ],
    });

    // The newest (id 2) is sent-not-delivered -> "Sent". The older delivered
    // line (id 1) is suppressed, so "Delivered" appears nowhere.
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });

  it("once the PEER replies (newest message is incoming) the indicator hides entirely", () => {
    renderPanel({
      messages: [
        mine({ id: 1, text: "mine", sent: true, delivered: true }),
        incoming({ id: 2, text: "their reply" }),
      ],
    });

    // Newest is the peer's reply -> our indicator hides; their reply is proof
    // enough. Neither label appears anywhere.
    expect(screen.getByText("their reply")).toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });
});

// --- Incoming messages never carry the indicator ----------------------------

describe("ChatPanel Delivery Echo — incoming messages have no indicator", () => {
  it("a lone incoming (mine:false) message renders NEITHER 'Sent' nor 'Delivered'", () => {
    renderPanel({ messages: [incoming()] });

    expect(screen.getByText("their message")).toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });

  it("a stray delivered flag on an incoming message is still not shown (mine-only)", () => {
    renderPanel({ messages: [incoming({ delivered: true })] });

    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });
});

// --- Polite live-region announcement on the delivered transition ------------

describe("ChatPanel Delivery Echo — polite 'Message delivered' announcement", () => {
  it("does NOT announce for a message resting at 'Sent'", () => {
    renderPanel({ messages: [mine({ sent: true })] });

    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByText("Message delivered")).not.toBeInTheDocument();
  });

  it("announces 'Message delivered' and flips the visible label when a message is acked", () => {
    const { rerender } = renderPanel({ messages: [mine({ id: 1, sent: true })] });
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByText("Message delivered")).not.toBeInTheDocument();

    // An ack lands: the same message id flips delivered -> true.
    act(() => {
      rerender(panel({ messages: [mine({ id: 1, sent: true, delivered: true })] }));
    });

    expect(screen.getByText("Message delivered")).toBeInTheDocument();
    // And the visible indicator agrees: Sent -> Delivered.
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
  });

  it("does NOT re-announce on an idempotent re-render where the delivered COUNT does not rise", () => {
    const delivered = [mine({ id: 1, sent: true, delivered: true })];
    const { rerender } = renderPanel({ messages: delivered });

    // Re-render with the SAME delivered count (e.g. a duplicate ack, or an
    // unrelated prop tick). The count (1) does not rise…
    act(() => {
      rerender(
        panel({
          messages: [mine({ id: 1, sent: true, delivered: true })],
          peerTyping: true,
        }),
      );
    });

    // …so the polite region is not re-populated by this no-op transition.
    expect(screen.queryByText("Message delivered")).not.toBeInTheDocument();
  });
});

// --- HONESTY: no timeout path to "Delivered" --------------------------------

describe("ChatPanel Delivery Echo — NO fake-advance to Delivered (honesty)", () => {
  it("advancing timers does NOT flip a Sent message to Delivered (an ack is the sole path)", () => {
    jest.useFakeTimers();
    try {
      // A live, sent-but-unacked outbound message. The Fade Trails shared ticker
      // and any other timers run, but none of them may invent a delivery.
      renderPanel({ messages: [mine({ sent: true })] });

      expect(screen.getByText("Sent")).toBeInTheDocument();
      expect(screen.queryByText("Delivered")).not.toBeInTheDocument();

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
