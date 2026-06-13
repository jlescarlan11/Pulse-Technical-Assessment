/**
 * @jest-environment jsdom
 *
 * Phase 4 "Reciprocal Video" — VideoPanel away-matrix UI tests.
 *
 * These assert the user-facing HONESTY contract: a black self-view / remote
 * feed is NEVER shown without an explanatory overlay, the four (peerAway,
 * localAway) combinations each render the correct copy, presence transitions are
 * announced in the polite aria-live region, and state is conveyed by icon+text
 * (not colour alone). We test observable text/roles, not internals.
 *
 * jsdom is scoped to this file via the docblock above so the node-env unit /
 * API suites are unaffected.
 */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import VideoPanel from "./VideoPanel";

// A stand-in MediaStream; VideoPanel only assigns it to <video>.srcObject and
// checks truthiness, so an empty object is enough. jsdom's HTMLVideoElement has
// no real media pipeline — assigning srcObject is a harmless no-op here.
const fakeStream = {} as unknown as MediaStream;

function panel(over: Partial<React.ComponentProps<typeof VideoPanel>> = {}) {
  return (
    <VideoPanel
      localStream={fakeStream}
      remoteStream={fakeStream}
      onEnd={() => {}}
      peerAway={false}
      localAway={false}
      {...over}
    />
  );
}

function renderPanel(over: Partial<React.ComponentProps<typeof VideoPanel>> = {}) {
  return render(panel(over));
}

/**
 * M3 latch: the mid-call "Stranger stepped away" overlay only shows once the
 * stranger has actually been present (peerAway observed false at least once).
 * peerAway initialises true (fail-closed), so a fresh call must NOT flash the
 * overlay before the first live frame. To exercise the genuine mid-call
 * stepped-away state in tests we first render with the peer present, then flip
 * them away — mirroring the real waiting -> live -> stepped-away sequence.
 */
function renderPeerSteppedAway(
  over: Partial<React.ComponentProps<typeof VideoPanel>> = {},
) {
  const utils = render(panel({ ...over, peerAway: false }));
  utils.rerender(panel({ ...over, peerAway: true }));
  return utils;
}

/**
 * The phrase "Stranger stepped away" lives in two places once the peer steps
 * away mid-call: the visible overlay heading AND the polite aria-live announcer
 * (role="status"). To assert on the visible overlay specifically, return the
 * match that is NOT inside the status region.
 */
function peerAwayOverlayTitle() {
  const status = screen.getByRole("status");
  const matches = screen.getAllByText("Stranger stepped away");
  const visible = matches.find((el) => !status.contains(el));
  if (!visible) throw new Error("peer-away overlay title not found outside the announcer");
  return visible;
}

describe("VideoPanel away matrix", () => {
  it("neither away -> live, no away overlays", () => {
    renderPanel({ peerAway: false, localAway: false });

    expect(screen.queryByText("Stranger stepped away")).not.toBeInTheDocument();
    expect(screen.queryByText("You stepped away")).not.toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
    // The live indicator is present.
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("only peer away -> 'Stranger stepped away' + PiP 'Paused' (not 'You stepped away')", () => {
    // M3: establish the stranger as present first, then have them step away.
    renderPeerSteppedAway({ localAway: false });

    expect(peerAwayOverlayTitle()).toBeInTheDocument();
    // Local PiP holds with the quieter "Paused" treatment because YOU are present.
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(
      screen.getByText("Held while they’re away · camera resumes when they’re back"),
    ).toBeInTheDocument();
    expect(screen.queryByText("You stepped away")).not.toBeInTheDocument();
    // M5: the HUD pill agrees with the overlay — calm "Away", no "Live".
    expect(screen.getByText("Away")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("only local away -> PiP 'You stepped away' + audio sub-line, no peer overlay", () => {
    renderPanel({ peerAway: false, localAway: true });

    expect(screen.getByText("You stepped away")).toBeInTheDocument();
    expect(
      screen.getByText("Paused while this tab is in the background · audio still on"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Stranger stepped away")).not.toBeInTheDocument();
    // "You stepped away" takes precedence over the quieter "Paused" in the PiP.
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });

  it("both away -> both overlays present ('You stepped away' wins the PiP)", () => {
    // M3: establish presence first, then both step away.
    renderPeerSteppedAway({ localAway: true });

    expect(peerAwayOverlayTitle()).toBeInTheDocument();
    expect(screen.getByText("You stepped away")).toBeInTheDocument();
    // PiP precedence: own action beats the quiet hold, so no "Paused".
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });

  it("conveys away state with icon + text, not colour alone", () => {
    // M3: establish presence first so the mid-call overlay is allowed to show.
    renderPeerSteppedAway({ localAway: false });

    // The peer-away overlay carries a textual title alongside its glyph, so the
    // state is legible without relying on colour/blur perception.
    const title = peerAwayOverlayTitle();
    expect(title).toBeInTheDocument();
    expect(title.tagName.toLowerCase()).toBe("p");
  });
});

describe("VideoPanel M3 — no call-start flicker", () => {
  it("does NOT show the stepped-away overlay before the stranger has ever been present", () => {
    // Fresh call: stream connected but peerAway is still its fail-closed `true`
    // and the stranger has never been seen present. The overlay must stay hidden
    // so the call reads waiting -> live, never waiting -> stepped-away -> live.
    renderPanel({ peerAway: true, localAway: false });

    expect(screen.queryByText("Stranger stepped away")).not.toBeInTheDocument();
    // The pill reads "Live", not the away state, until presence is established.
    expect(screen.getByText("Live")).toBeInTheDocument();
  });
});

describe("VideoPanel pre-call waiting state", () => {
  it("shows the waiting copy before any remote stream arrives", () => {
    renderPanel({ remoteStream: null, peerAway: true, localAway: false });

    expect(screen.getByText(/Waiting for stranger’s video/)).toBeInTheDocument();
    // Pre-call: the mid-call "Stranger stepped away" overlay must NOT show even
    // though peerAway is true — it only appears once a stream has connected.
    expect(screen.queryByText("Stranger stepped away")).not.toBeInTheDocument();
  });
});

describe("VideoPanel aria-live presence announcements", () => {
  function liveRegion() {
    return screen.getByRole("status");
  }

  it("has a polite live region", () => {
    renderPanel();
    expect(liveRegion()).toHaveAttribute("aria-live", "polite");
  });

  it("announces 'Stranger stepped away' when the peer leaves mid-call", () => {
    const { rerender } = renderPanel({ peerAway: false, localAway: false });
    rerender(
      <VideoPanel
        localStream={fakeStream}
        remoteStream={fakeStream}
        onEnd={() => {}}
        peerAway={true}
        localAway={false}
      />,
    );
    expect(within(liveRegion()).getByText("Stranger stepped away")).toBeInTheDocument();
  });

  it("announces 'Stranger is back' when a connected peer returns", () => {
    // Start away (after a connection existed), then return.
    const { rerender } = renderPanel({ peerAway: true, localAway: false });
    rerender(
      <VideoPanel
        localStream={fakeStream}
        remoteStream={fakeStream}
        onEnd={() => {}}
        peerAway={false}
        localAway={false}
      />,
    );
    expect(within(liveRegion()).getByText("Stranger is back")).toBeInTheDocument();
  });

  it("announces 'You’re back' when the local user returns", () => {
    const { rerender } = renderPanel({ peerAway: false, localAway: true });
    rerender(
      <VideoPanel
        localStream={fakeStream}
        remoteStream={fakeStream}
        onEnd={() => {}}
        peerAway={false}
        localAway={false}
      />,
    );
    expect(within(liveRegion()).getByText("You’re back")).toBeInTheDocument();
  });
});
