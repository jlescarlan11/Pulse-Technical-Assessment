/**
 * @jest-environment jsdom
 *
 * Phase 4 "Reciprocal Video" — VideoPanel away-matrix UI tests.
 *
 * These assert the user-facing HONESTY contract. The Privacy Shield update
 * changed the LOCAL PiP: the self-view camera track is now ALWAYS LIVE (only a
 * separate clone sent to the peer is gated), so the PiP <video> stays visible
 * in every state and is NEVER covered by a black "Paused" box. When the
 * outgoing clone is held (localAway || peerAway) a compact, non-blocking
 * "Not shared" badge is laid over the live self-view, with an honest
 * tab/presence sub-line. The remote-side full-screen "Stranger stepped away"
 * overlay, the Live/Away pill, and the aria-live announcements are UNCHANGED.
 *
 * We test observable text/roles, not internals. State is conveyed by icon+text
 * (not colour alone).
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
 * The phrase "Stranger stepped away" lives in the visible remote overlay
 * heading. The polite aria-live announcer now uses a longer, distinct sentence
 * ("Stranger stepped away. Your video is no longer shared…"), so an exact-text
 * match on "Stranger stepped away" returns only the overlay heading. We still
 * exclude any match inside the status region to stay robust if the announcer
 * wording changes.
 */
function peerAwayOverlayTitle() {
  const status = screen.getByRole("status");
  const matches = screen.getAllByText("Stranger stepped away");
  const visible = matches.find((el) => !status.contains(el));
  if (!visible) throw new Error("peer-away overlay title not found outside the announcer");
  return visible;
}

describe("VideoPanel away matrix", () => {
  it("neither away -> live self-view with 'You' label, no away overlays or badge", () => {
    renderPanel({ peerAway: false, localAway: false });

    expect(screen.queryByText("Stranger stepped away")).not.toBeInTheDocument();
    // Privacy Shield: no "not shared" badge when the feed is actually shared.
    expect(screen.queryByText("Not shared")).not.toBeInTheDocument();
    // The live self-view carries just the normal "You" label.
    expect(screen.getByText("You")).toBeInTheDocument();
    // The live indicator is present.
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("only peer away -> remote 'Stranger stepped away' + PiP 'Not shared' (peer-attributed)", () => {
    // M3: establish the stranger as present first, then have them step away.
    renderPeerSteppedAway({ localAway: false });

    expect(peerAwayOverlayTitle()).toBeInTheDocument();
    // Privacy Shield: the self-view stays LIVE; a non-blocking "Not shared"
    // badge explains the outgoing clone is held while you remain present.
    expect(screen.getByText("Not shared")).toBeInTheDocument();
    expect(
      screen.getByText("Not shared · they can’t see you while they’re away"),
    ).toBeInTheDocument();
    // BUG-2: this only-peer-away attribution must be the genuine mid-call one,
    // never the pre-heartbeat connecting line.
    expect(screen.queryByText("Connecting · not shared yet")).not.toBeInTheDocument();
    // The "You" label is replaced by the badge while the feed is held.
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    // M5: the HUD pill agrees with the overlay — calm "Away", no "Live".
    expect(screen.getByText("Away")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("only local away -> PiP 'Not shared' with backgrounded-tab sub-line, no peer overlay", () => {
    renderPanel({ peerAway: false, localAway: true });

    expect(screen.getByText("Not shared")).toBeInTheDocument();
    expect(
      screen.getByText("Not shared while your tab is in the background"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Stranger stepped away")).not.toBeInTheDocument();
    // The local-away cause wins the badge, so the peer-attributed line is absent.
    expect(
      screen.queryByText("Not shared · they can’t see you while they’re away"),
    ).not.toBeInTheDocument();
  });

  it("both away -> remote overlay present + PiP 'Not shared' (your-tab cause wins)", () => {
    // M3: establish presence first, then both step away.
    renderPeerSteppedAway({ localAway: true });

    expect(peerAwayOverlayTitle()).toBeInTheDocument();
    expect(screen.getByText("Not shared")).toBeInTheDocument();
    // Badge precedence: your own backgrounded tab is named over the peer line.
    expect(
      screen.getByText("Not shared while your tab is in the background"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Not shared · they can’t see you while they’re away"),
    ).not.toBeInTheDocument();
  });

  it("conveys away state with icon + text, not colour alone", () => {
    // M3: establish presence first so the mid-call overlay is allowed to show.
    renderPeerSteppedAway({ localAway: false });

    // The peer-away overlay carries a textual title alongside its glyph, so the
    // state is legible without relying on colour/blur perception.
    const title = peerAwayOverlayTitle();
    expect(title).toBeInTheDocument();
    expect(title.tagName.toLowerCase()).toBe("p");
    // The PiP "not shared" badge is also text, not colour alone.
    expect(screen.getByText("Not shared")).toBeInTheDocument();
  });
});

describe("VideoPanel Privacy Shield — self-view stays live", () => {
  it("never covers the PiP with a black 'Paused' / 'Securing video…' box in any held state", () => {
    // The legacy black-box copy is gone; the self-view <video> is always live.
    renderPanel({ peerAway: false, localAway: true });
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
    expect(screen.queryByText("You stepped away")).not.toBeInTheDocument();
    expect(screen.queryByText("Securing video…")).not.toBeInTheDocument();
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

describe("VideoPanel BUG-2 — startup PiP attribution", () => {
  it("pre-first-heartbeat (peerAway fail-closed true, never present): badge shows neutral 'Connecting · not shared yet', NOT the peer-attributed line", () => {
    // Fresh call: stream is connected but peerAway is still its initial
    // fail-closed `true` and the stranger has NEVER been seen present, so the
    // outgoing clone is held even though the stranger didn't actually step away.
    // The badge must not blame them — it shows the neutral connecting line.
    renderPanel({ peerAway: true, localAway: false });

    expect(screen.getByText("Not shared")).toBeInTheDocument();
    expect(screen.getByText("Connecting · not shared yet")).toBeInTheDocument();
    // No stranger-attributed copy before the first heartbeat.
    expect(
      screen.queryByText("Not shared · they can’t see you while they’re away"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Stranger stepped away")).not.toBeInTheDocument();
  });

  it("once the stranger has been present, a later step-away switches the badge to the peer-attributed line", () => {
    // present -> away: now the hold is genuinely the stranger's doing, so the
    // badge is allowed to attribute it to them and the connecting line is gone.
    renderPeerSteppedAway({ localAway: false });

    expect(screen.getByText("Not shared")).toBeInTheDocument();
    expect(
      screen.getByText("Not shared · they can’t see you while they’re away"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Connecting · not shared yet")).not.toBeInTheDocument();
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

  it("announces the stranger stepping away (sharing-honest) when the peer leaves mid-call", () => {
    // Start with the stranger present (so peerHasBeenPresent latches true and a
    // connection exists), then have them step away — matching the visual overlay
    // condition the BUG-5 fix gates the announcement on. The announcement now
    // describes sharing honestly: the video is no longer shared while they're away.
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
    expect(
      within(liveRegion()).getByText(/Stranger stepped away\. Your video is no longer shared/),
    ).toBeInTheDocument();
  });

  it("BUG-5: does NOT announce the stranger stepping away at startup before the peer has ever been present", () => {
    // peerAway initialises true (fail-closed) on a fresh call. Because the
    // visual overlay is gated on hasConnected && peerHasBeenPresent, the
    // announcement must be too — otherwise a screen reader would say "Stranger
    // stepped away" while the screen reads "Live". The announcer stays empty.
    renderPanel({ peerAway: true, localAway: false });
    expect(within(liveRegion()).queryByText(/Stranger stepped away/)).not.toBeInTheDocument();
  });

  it("announces the stranger is back (sharing-honest) when a connected peer returns", () => {
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
    expect(
      within(liveRegion()).getByText(/Stranger is back\. Your video is shared again/),
    ).toBeInTheDocument();
  });

  it("announces 'You’re back' (sharing-honest) when the local user returns", () => {
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
    expect(
      within(liveRegion()).getByText(/You’re back\. Your video is shared again/),
    ).toBeInTheDocument();
  });
});
