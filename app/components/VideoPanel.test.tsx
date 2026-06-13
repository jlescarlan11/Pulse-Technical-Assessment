/**
 * @jest-environment jsdom
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VideoPanel from "./VideoPanel";
import {
  SAS_MISMATCH_WARNING,
  SAS_UNAVAILABLE_MESSAGE,
  type SasStatus,
} from "./SafetyPhrase";
import type { SasPhrase } from "@/lib/sas";

const PHRASE: SasPhrase = [
  { word: "anchor", emoji: "⚓" },
  { word: "banana", emoji: "🍌" },
  { word: "comet", emoji: "☄️" },
  { word: "dragon", emoji: "🐉" },
  { word: "ember", emoji: "🔥" },
];

// jsdom has no real MediaStream; the component only assigns it to video.srcObject
// and reads truthiness for layout, so a bare object stands in fine.
function fakeStream(): MediaStream {
  return {} as unknown as MediaStream;
}

function renderVideo(overrides: Partial<React.ComponentProps<typeof VideoPanel>> = {}) {
  const onEnd = jest.fn();
  const onConfirmMatch = jest.fn();
  const onFlagMismatch = jest.fn();

  const props: React.ComponentProps<typeof VideoPanel> = {
    localStream: fakeStream(),
    // A null remote keeps the controls pinned up (no auto-calm countdown),
    // which makes the scrim panel deterministically visible for assertions.
    remoteStream: null,
    onEnd,
    sasPhrase: null,
    sasStatus: "pending" as SasStatus,
    onConfirmMatch,
    onFlagMismatch,
    ...overrides,
  };

  render(<VideoPanel {...props} />);
  return { onEnd, onConfirmMatch, onFlagMismatch };
}

describe("VideoPanel — safety phrase per status", () => {
  it("flagged surfaces the FULL warning sentence, not a bare unexplained chip", () => {
    renderVideo({ sasStatus: "flagged", sasPhrase: PHRASE });

    // The complete danger sentence must be on the visible surface...
    expect(screen.getByText(SAS_MISMATCH_WARNING)).toBeInTheDocument();
    // ...and announced assertively.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(SAS_MISMATCH_WARNING);
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("pending renders a consistent securing indicator", () => {
    renderVideo({ sasStatus: "pending", sasPhrase: null });
    expect(screen.getByText(/securing/i)).toBeInTheDocument();
  });

  it("unavailable renders the unavailable message and is not a positive assurance", () => {
    renderVideo({ sasStatus: "unavailable", sasPhrase: null });
    // Visible body + polite sr-only announcement both carry the copy.
    expect(screen.getAllByText(SAS_UNAVAILABLE_MESSAGE).length).toBeGreaterThan(0);
    expect(screen.getByRole("status")).toHaveTextContent(SAS_UNAVAILABLE_MESSAGE);
    expect(screen.queryByText(/^Verified end-to-end$/i)).toBeNull();
  });

  it("unverified renders the phrase tokens and both verify buttons", () => {
    renderVideo({ sasStatus: "unverified", sasPhrase: PHRASE });

    const list = screen.getByRole("list", { name: /safety phrase:/i });
    expect(within(list).getAllByRole("listitem")).toHaveLength(PHRASE.length);
    expect(screen.getByRole("button", { name: /they match/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /they don.?t match/i })).toBeEnabled();
  });

  it("verified shows the verified end-to-end treatment", () => {
    renderVideo({ sasStatus: "verified", sasPhrase: PHRASE });
    // Exact visible chip, plus the polite sr-only announcement.
    expect(screen.getByText(/^Verified end-to-end$/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/verified end-to-end/i);
  });
});

describe("VideoPanel — verify control side effects", () => {
  it("clicking 'They match' calls only onConfirmMatch", async () => {
    const user = userEvent.setup();
    const { onConfirmMatch, onFlagMismatch } = renderVideo({
      sasStatus: "unverified",
      sasPhrase: PHRASE,
    });
    await user.click(screen.getByRole("button", { name: /they match/i }));
    expect(onConfirmMatch).toHaveBeenCalledTimes(1);
    expect(onFlagMismatch).not.toHaveBeenCalled();
  });

  it("clicking 'They don't match' calls only onFlagMismatch", async () => {
    const user = userEvent.setup();
    const { onConfirmMatch, onFlagMismatch } = renderVideo({
      sasStatus: "unverified",
      sasPhrase: PHRASE,
    });
    await user.click(screen.getByRole("button", { name: /they don.?t match/i }));
    expect(onFlagMismatch).toHaveBeenCalledTimes(1);
    expect(onConfirmMatch).not.toHaveBeenCalled();
  });
});

describe("VideoPanel — controls calm vs. unverified pin (M1)", () => {
  // With a remote stream present the top scrim normally auto-calms after the
  // idle countdown. The unverified verify prompt must be EXEMPT from that calm —
  // reading the phrase aloud outlasts the timeout, so the buttons have to stay
  // reachable. We advance well past the calm window and assert the buttons are
  // still rendered and clickable.
  it("keeps the verify buttons reachable after the idle calm window while unverified", () => {
    jest.useFakeTimers();
    try {
      renderVideo({
        sasStatus: "unverified",
        sasPhrase: PHRASE,
        remoteStream: fakeStream(),
      });

      act(() => {
        jest.advanceTimersByTime(10000);
      });

      const matchBtn = screen.getByRole("button", { name: /they match/i });
      const noMatchBtn = screen.getByRole("button", { name: /they don.?t match/i });
      expect(matchBtn).toBeEnabled();
      expect(noMatchBtn).toBeEnabled();
      // The phrase the user must read aloud is still on the surface too.
      expect(
        within(screen.getByRole("list", { name: /safety phrase:/i })).getAllByRole(
          "listitem",
        ),
      ).toHaveLength(PHRASE.length);
    } finally {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    }
  });
});
