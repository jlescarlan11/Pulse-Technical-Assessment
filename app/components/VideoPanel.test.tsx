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
 * "not shared" badge is laid over the live self-view.
 *
 * FIX 1 (Phase 4 polish): the badge is now a SINGLE compact pill — icon + one
 * short, one-line label — instead of a pill PLUS a long wrapping sub-line. At
 * the ~128px PiP width the old sub-line wrapped to ~4 ugly lines, so the "why"
 * is left to the full-screen overlay and the pill carries only a short label
 * that varies per gated case:
 *   - only-peer-away  -> "Not shared"        (you're present, they stepped away)
 *   - local-away      -> "Tab in background" (your own tab is backgrounded)
 *   - pre-heartbeat   -> "Connecting…"       (fail-closed, never blame the peer)
 * The remote-side full-screen "Stranger stepped away" overlay, the Live/Away
 * pill, and the aria-live announcements are UNCHANGED.
 *
 * We test observable text/roles, not internals. State is conveyed by icon+text
 * (not colour alone).
 *
 * jsdom is scoped to this file via the docblock above so the node-env unit /
 * API suites are unaffected.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import VideoPanel from "./VideoPanel";
import { DEFAULT_FILTER_ID } from "@/lib/videoFilters";

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
      isMuted={false}
      onToggleMute={() => {}}
      isCameraOn={true}
      onToggleCamera={() => {}}
      peerMuted={false}
      peerCameraOn={true}
      selectedFilter={DEFAULT_FILTER_ID}
      onSelectFilter={() => {}}
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
 * exclude any match inside a status region to stay robust if the announcer
 * wording changes.
 */
function peerAwayOverlayTitle() {
  const statuses = screen.getAllByRole("status");
  const matches = screen.getAllByText("Stranger stepped away");
  const visible = matches.find((el) => !statuses.some((s) => s.contains(el)));
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

  it("only peer away -> remote 'Stranger stepped away' + compact PiP 'Not shared' pill", () => {
    // M3: establish the stranger as present first, then have them step away.
    renderPeerSteppedAway({ localAway: false });

    expect(peerAwayOverlayTitle()).toBeInTheDocument();
    // FIX 1: the self-view stays LIVE; the badge is a SINGLE compact pill that
    // reads just "Not shared" (peer-attributed). No wrapping sub-line.
    expect(screen.getByText("Not shared")).toBeInTheDocument();
    // The old long peer-attributed sub-line is gone — it must NOT render.
    expect(
      screen.queryByText("Not shared · they can’t see you while they’re away"),
    ).not.toBeInTheDocument();
    // BUG-2: this only-peer-away pill must be the genuine mid-call one, never
    // the pre-heartbeat connecting label.
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
    // The "You" label is replaced by the badge while the feed is held.
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    // M5: the HUD pill agrees with the overlay — calm "Away", no "Live".
    expect(screen.getByText("Away")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("only local away -> compact PiP 'Tab in background' pill, no peer overlay", () => {
    renderPanel({ peerAway: false, localAway: true });

    // FIX 1: your own backgrounded tab is named by the short pill label.
    expect(screen.getByText("Tab in background")).toBeInTheDocument();
    expect(screen.queryByText("Stranger stepped away")).not.toBeInTheDocument();
    // The local-away cause wins the badge, so the peer-attributed "Not shared"
    // pill is absent and no long sub-line wraps.
    expect(screen.queryByText("Not shared")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Not shared while your tab is in the background"),
    ).not.toBeInTheDocument();
  });

  it("both away -> remote overlay present + compact PiP 'Tab in background' (your-tab cause wins)", () => {
    // M3: establish presence first, then both step away.
    renderPeerSteppedAway({ localAway: true });

    expect(peerAwayOverlayTitle()).toBeInTheDocument();
    // Badge precedence: your own backgrounded tab is named over the peer label.
    expect(screen.getByText("Tab in background")).toBeInTheDocument();
    expect(screen.queryByText("Not shared")).not.toBeInTheDocument();
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
  it("pre-first-heartbeat (peerAway fail-closed true, never present): pill shows neutral 'Connecting…', NOT the peer-attributed 'Not shared'", () => {
    // Fresh call: stream is connected but peerAway is still its initial
    // fail-closed `true` and the stranger has NEVER been seen present, so the
    // outgoing clone is held even though the stranger didn't actually step away.
    // The badge must not blame them — it shows the neutral connecting label.
    renderPanel({ peerAway: true, localAway: false });

    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    // No stranger-attributed copy before the first heartbeat.
    expect(screen.queryByText("Not shared")).not.toBeInTheDocument();
    expect(screen.queryByText("Stranger stepped away")).not.toBeInTheDocument();
  });

  it("once the stranger has been present, a later step-away switches the pill to the peer-attributed 'Not shared'", () => {
    // present -> away: now the hold is genuinely the stranger's doing, so the
    // badge is allowed to attribute it to them and the connecting label is gone.
    renderPeerSteppedAway({ localAway: false });

    expect(screen.getByText("Not shared")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
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

  it("M5: escalates the waiting copy after the grace window when no stream arrives", () => {
    jest.useFakeTimers();
    try {
      renderPanel({ remoteStream: null, peerAway: true, localAway: false });

      // Before the grace window: the calm pre-call copy, no camera-trouble hint.
      expect(screen.getByText(/Waiting for stranger’s video/)).toBeInTheDocument();
      expect(
        screen.queryByText("Still waiting — they may be having camera trouble"),
      ).not.toBeInTheDocument();

      // After the grace window: softer copy + a reminder that End is available.
      // (act-wrapped so the state update from the timer is flushed.)
      act(() => {
        jest.advanceTimersByTime(9000);
      });

      expect(
        screen.getByText("Still waiting — they may be having camera trouble"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("You can leave anytime with End video below."),
      ).toBeInTheDocument();
      // The End control is force-shown in the pre-stream state (icon-only button).
      expect(screen.getByLabelText("End video call")).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("M5: does NOT escalate once a remote stream has arrived", () => {
    jest.useFakeTimers();
    try {
      // Stream present from the start: we never enter the waiting state, so the
      // escalation timer must never surface the camera-trouble copy.
      renderPanel({ remoteStream: fakeStream, peerAway: false, localAway: false });
      act(() => {
        jest.advanceTimersByTime(20000);
      });

      expect(
        screen.queryByText("Still waiting — they may be having camera trouble"),
      ).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("VideoPanel aria-live presence announcements", () => {
  function liveRegion() {
    // Story 7's polite presence announcer is the SR-only region. The pre-call
    // waiting copy also uses role=status, but that block is absent whenever a
    // remote stream is present (every test here renders with one), so the
    // announcer is the sole status node.
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
    rerender(panel({ peerAway: true, localAway: false }));
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
    rerender(panel({ peerAway: false, localAway: false }));
    expect(
      within(liveRegion()).getByText(/Stranger is back\. Your video is shared again/),
    ).toBeInTheDocument();
  });

  it("announces 'You’re back' (sharing-honest) when the local user returns", () => {
    const { rerender } = renderPanel({ peerAway: false, localAway: true });
    rerender(panel({ peerAway: false, localAway: false }));
    expect(
      within(liveRegion()).getByText(/You’re back\. Your video is shared again/),
    ).toBeInTheDocument();
  });
});

describe("Phase 5 — mute & camera controls", () => {
  it("renders mute, camera, and end buttons with accessible labels", () => {
    renderPanel();
    expect(screen.getByLabelText("Mute")).toBeInTheDocument();
    expect(screen.getByLabelText("Turn off camera")).toBeInTheDocument();
    expect(screen.getByLabelText("End video call")).toBeInTheDocument();
  });

  it("flips the mute button label and aria-pressed when muted", () => {
    renderPanel({ isMuted: true });
    const btn = screen.getByLabelText("Unmute");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("flips the camera button label and aria-pressed when camera off", () => {
    renderPanel({ isCameraOn: false });
    const btn = screen.getByLabelText("Turn on camera");
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("fires onToggleMute / onToggleCamera on click", () => {
    const onToggleMute = jest.fn();
    const onToggleCamera = jest.fn();
    renderPanel({ onToggleMute, onToggleCamera });
    fireEvent.click(screen.getByLabelText("Mute"));
    fireEvent.click(screen.getByLabelText("Turn off camera"));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(onToggleCamera).toHaveBeenCalledTimes(1);
  });

  it("shows the peer 'Muted' badge only when the peer is muted", () => {
    const { rerender } = renderPanel({ peerMuted: false });
    expect(screen.queryByText("Muted")).not.toBeInTheDocument();
    rerender(panel({ peerMuted: true }));
    expect(screen.getByText("Muted")).toBeInTheDocument();
  });

  it("shows the peer 'Camera off' badge only when the peer's camera is off", () => {
    const { rerender } = renderPanel({ peerCameraOn: true });
    expect(screen.queryByText("Camera off")).not.toBeInTheDocument();
    rerender(panel({ peerCameraOn: false }));
    expect(screen.getByText("Camera off")).toBeInTheDocument();
  });

  it("labels the local PiP 'only you see this' when YOU turn your camera off (self-view stays live)", () => {
    renderPanel({ isCameraOn: false, peerAway: false, localAway: false });
    // Honest: the self-view is live but the peer receives black, so the badge
    // explains the feed is not shared — it never claims to stop recording.
    expect(screen.getByText("Off · only you see this")).toBeInTheDocument();
    // ...and the normal "You" label is replaced by the not-shared pill.
    expect(screen.queryByText("You")).not.toBeInTheDocument();
  });
});

describe("VideoPanel camera-filter picker — audit fixes", () => {
  function liveRegion() {
    return screen.getByRole("status");
  }

  it("S4: marks an active non-none filter distinctly from the open state (ring + named label)", () => {
    renderPanel({ selectedFilter: "warm" });
    // The toggle's accessible name names the active grade — legible to SR users
    // separately from aria-expanded (open/closed).
    const toggle = screen.getByRole("button", { name: /Camera filter \(Warm active\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.className).toContain("ring-signal");
  });

  it("S4: a 'none' filter shows neither the active ring nor an active label", () => {
    renderPanel({ selectedFilter: "none" });
    const toggle = screen.getByRole("button", { name: "Camera filter" });
    expect(toggle.className).not.toContain("ring-signal");
  });

  it("B2: opening the picker moves focus to the checked radio option", () => {
    renderPanel({ selectedFilter: "warm" });
    fireEvent.click(screen.getByRole("button", { name: /Camera filter/ }));
    const checked = screen.getByRole("radio", { name: /WARM/ });
    expect(checked).toHaveFocus();
  });

  it("B1: Escape closes the picker and returns focus to the toggle", () => {
    renderPanel({ selectedFilter: "none" });
    const toggle = screen.getByRole("button", { name: /Camera filter/ });
    fireEvent.click(toggle);
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it("B1: a pointerdown outside the picker dismisses it", () => {
    renderPanel({ selectedFilter: "none" });
    fireEvent.click(screen.getByRole("button", { name: /Camera filter/ }));
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("S1: committing a pick (click) applies it AND closes the picker", () => {
    const onSelectFilter = jest.fn();
    renderPanel({ selectedFilter: "none", onSelectFilter });
    fireEvent.click(screen.getByRole("button", { name: /Camera filter/ }));
    fireEvent.click(screen.getByRole("radio", { name: /MONO/ }));
    expect(onSelectFilter).toHaveBeenCalledWith("mono");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("S1: arrow-roving previews WITHOUT closing the picker", () => {
    const onSelectFilter = jest.fn();
    renderPanel({ selectedFilter: "none", onSelectFilter });
    fireEvent.click(screen.getByRole("button", { name: /Camera filter/ }));
    const none = screen.getByRole("radio", { name: /NONE/ });
    fireEvent.keyDown(none, { key: "ArrowDown" });
    // Preview applied, but the picker stays open for further roaming.
    expect(onSelectFilter).toHaveBeenCalledWith("night");
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
  });

  it("S3: announces the effective filter by name when it changes", () => {
    const { rerender } = renderPanel({ selectedFilter: "none" });
    rerender(panel({ selectedFilter: "warm" }));
    expect(within(liveRegion()).getByText("Camera filter: Warm")).toBeInTheDocument();
  });

  it("S3: announces the honest fallback when a requested grade comes back 'none'", () => {
    // Request "night" via the picker, but the parent's effective selectedFilter
    // stays "none" (canvas pipeline unavailable) — the announcer must say the
    // feed is unfiltered rather than imply the grade applied.
    let last: string | null = null;
    const onSelectFilter = jest.fn((id: string) => {
      last = id;
    });
    const { rerender } = renderPanel({ selectedFilter: "none", onSelectFilter });
    fireEvent.click(screen.getByRole("button", { name: /Camera filter/ }));
    fireEvent.click(screen.getByRole("radio", { name: /NIGHT/ }));
    expect(last).toBe("night");
    // Parent reports the fallback: effective filter remains "none".
    rerender(panel({ selectedFilter: "none", onSelectFilter }));
    expect(
      within(liveRegion()).getByText("Filter unavailable — sending unfiltered video."),
    ).toBeInTheDocument();
  });
});
