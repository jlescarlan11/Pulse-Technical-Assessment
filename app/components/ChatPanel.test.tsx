/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatPanel, { type ChatMessage } from "./ChatPanel";
import {
  SAS_COMPARE_PROMPT,
  SAS_MISMATCH_WARNING,
  SAS_UNAVAILABLE_MESSAGE,
  SAS_WHY_COMPARE,
  type SasStatus,
} from "./SafetyPhrase";
import type { SasPhrase } from "@/lib/sas";

// A deliberately 5-token phrase: the count bumped 4→5 in Phase 4 and the UI is
// supposed to stay count-agnostic, so the fixture exercises the wider list.
const PHRASE: SasPhrase = [
  { word: "anchor", emoji: "⚓" },
  { word: "banana", emoji: "🍌" },
  { word: "comet", emoji: "☄️" },
  { word: "dragon", emoji: "🐉" },
  { word: "ember", emoji: "🔥" },
];

function renderChat(overrides: Partial<React.ComponentProps<typeof ChatPanel>> = {}) {
  const onConfirmMatch = jest.fn();
  const onFlagMismatch = jest.fn();
  const onSend = jest.fn();
  const onStartVideo = jest.fn();
  const onEnd = jest.fn();
  const messages: ChatMessage[] = [];

  const props: React.ComponentProps<typeof ChatPanel> = {
    messages,
    connected: true,
    videoBusy: false,
    onSend,
    onStartVideo,
    onEnd,
    peerId: "peer-1",
    sasPhrase: null,
    sasStatus: "pending" as SasStatus,
    onConfirmMatch,
    onFlagMismatch,
    ...overrides,
  };

  render(<ChatPanel {...props} />);
  return { onConfirmMatch, onFlagMismatch, onSend, onStartVideo, onEnd };
}

// The safety-phrase surface in the chat header is its own labelled section.
function sasRegion() {
  return screen.getByRole("region", { name: /safety phrase verification/i });
}

describe("ChatPanel — safety phrase affordances per status", () => {
  describe("pending", () => {
    it("shows the establishing treatment and no actionable verify buttons", () => {
      renderChat({ sasStatus: "pending", sasPhrase: null });

      const region = sasRegion();
      expect(within(region).getByText(/establishing secure phrase/i)).toBeInTheDocument();

      // No verify affordances exist while establishing.
      expect(within(region).queryByRole("button", { name: /they match/i })).toBeNull();
      expect(
        within(region).queryByRole("button", { name: /they don.?t match/i }),
      ).toBeNull();
      // The phrase tokens are not rendered yet.
      expect(within(region).queryByRole("list", { name: /safety phrase:/i })).toBeNull();
    });

    it("stays in establishing treatment if status is unverified but no phrase derived yet", () => {
      // Defensive: status raced ahead of the phrase. Must not show empty tokens.
      renderChat({ sasStatus: "unverified", sasPhrase: null });
      expect(within(sasRegion()).getByText(/establishing secure phrase/i)).toBeInTheDocument();
    });
  });

  describe("unverified", () => {
    it("renders the phrase tokens, the why-compare line, and both verify buttons", () => {
      renderChat({ sasStatus: "unverified", sasPhrase: PHRASE });
      const region = sasRegion();

      // The "why" explainer and the call to action.
      expect(within(region).getByText(SAS_WHY_COMPARE)).toBeInTheDocument();
      expect(within(region).getByText(SAS_COMPARE_PROMPT)).toBeInTheDocument();

      // Both controls are real, enabled buttons.
      const match = within(region).getByRole("button", { name: /they match/i });
      const mismatch = within(region).getByRole("button", { name: /they don.?t match/i });
      expect(match).toBeEnabled();
      expect(mismatch).toBeEnabled();
    });
  });

  describe("verified", () => {
    it("shows the verified end-to-end treatment and removes the verify controls", () => {
      renderChat({ sasStatus: "verified", sasPhrase: PHRASE });
      const region = sasRegion();

      // Visible chip (exact) plus the polite sr-only announcement both carry it.
      expect(within(region).getByText(/^Verified end-to-end$/i)).toBeInTheDocument();
      const status = within(region).getByRole("status");
      expect(status).toHaveTextContent(/verified end-to-end/i);
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(within(region).queryByRole("button", { name: /they match/i })).toBeNull();
      expect(
        within(region).queryByRole("button", { name: /they don.?t match/i }),
      ).toBeNull();
    });
  });

  describe("flagged", () => {
    it("surfaces the full mismatch warning sentence", () => {
      renderChat({ sasStatus: "flagged", sasPhrase: PHRASE });
      // The exact danger copy must be present (visible body, not only sr-only).
      expect(
        screen.getAllByText((_t, node) => node?.textContent === `Not verified. ${SAS_MISMATCH_WARNING}`)
          .length,
      ).toBeGreaterThan(0);
    });

    it("announces the mismatch via an assertive alert live region", () => {
      renderChat({ sasStatus: "flagged", sasPhrase: PHRASE });
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(SAS_MISMATCH_WARNING);
      expect(alert).toHaveAttribute("aria-live", "assertive");
    });
  });

  describe("unavailable", () => {
    it("shows the unavailable message and is not presented as a positive assurance", () => {
      renderChat({ sasStatus: "unavailable", sasPhrase: null });
      const region = sasRegion();

      // Present on the visible surface (and mirrored in the polite sr-only region).
      expect(within(region).getAllByText(SAS_UNAVAILABLE_MESSAGE).length).toBeGreaterThan(0);
      const status = within(region).getByRole("status");
      expect(status).toHaveTextContent(SAS_UNAVAILABLE_MESSAGE);

      // Must NOT read as verified, and must offer no verify controls.
      expect(within(region).queryByText(/verified end-to-end/i)).toBeNull();
      expect(within(region).queryByRole("button", { name: /they match/i })).toBeNull();
    });
  });
});

describe("ChatPanel — verify control side effects", () => {
  it("clicking 'They match' calls onConfirmMatch and nothing else", async () => {
    const user = userEvent.setup();
    const { onConfirmMatch, onFlagMismatch } = renderChat({
      sasStatus: "unverified",
      sasPhrase: PHRASE,
    });

    await user.click(screen.getByRole("button", { name: /they match/i }));

    expect(onConfirmMatch).toHaveBeenCalledTimes(1);
    expect(onFlagMismatch).not.toHaveBeenCalled();
  });

  it("clicking 'They don't match' calls onFlagMismatch and nothing else", async () => {
    const user = userEvent.setup();
    const { onConfirmMatch, onFlagMismatch } = renderChat({
      sasStatus: "unverified",
      sasPhrase: PHRASE,
    });

    await user.click(screen.getByRole("button", { name: /they don.?t match/i }));

    expect(onFlagMismatch).toHaveBeenCalledTimes(1);
    expect(onConfirmMatch).not.toHaveBeenCalled();
  });
});

describe("ChatPanel — phrase tokens", () => {
  it("renders exactly the tokens passed in, in order, count-agnostic (5 tokens)", () => {
    renderChat({ sasStatus: "unverified", sasPhrase: PHRASE });

    const list = screen.getByRole("list", {
      name: /safety phrase: anchor, banana, comet, dragon, ember/i,
    });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(PHRASE.length);
    items.forEach((li, i) => {
      expect(li).toHaveTextContent(PHRASE[i].word);
    });
  });

  it("exposes the words to assistive tech and hides the decorative emoji", () => {
    renderChat({ sasStatus: "unverified", sasPhrase: PHRASE });
    const list = screen.getByRole("list", { name: /safety phrase:/i });

    // The accessible name carries the words (the meaning), never a hardcoded count.
    expect(list).toHaveAccessibleName(
      "Safety phrase: anchor, banana, comet, dragon, ember",
    );

    // Each emoji glyph is aria-hidden; the word is exposed.
    const emojiSpans = within(list)
      .getAllByText((_t, node) => node?.getAttribute("aria-hidden") === "true")
      .filter((n) => PHRASE.some((p) => n.textContent === p.emoji));
    expect(emojiSpans).toHaveLength(PHRASE.length);
  });
});

describe("ChatPanel — accessibility of verify controls", () => {
  it("verify affordances are real <button>s reachable by role", () => {
    renderChat({ sasStatus: "unverified", sasPhrase: PHRASE });
    const match = screen.getByRole("button", { name: /they match/i });
    const mismatch = screen.getByRole("button", { name: /they don.?t match/i });
    expect(match.tagName).toBe("BUTTON");
    expect(mismatch.tagName).toBe("BUTTON");
    expect(match).toHaveAttribute("type", "button");
    expect(mismatch).toHaveAttribute("type", "button");
  });
});
