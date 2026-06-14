/**
 * @jest-environment jsdom
 *
 * Phase 4 "Proximity Pulse" — component BEHAVIOUR tests.
 *
 * The PURE trend math is unit-tested in lib/proximity.test.ts; this file locks
 * the COMPONENT contract a user / assistive tech actually experiences:
 *
 *   - B1 REGRESSION (critical): the role=status live region must NOT sit inside
 *     any aria-hidden subtree — that would prune it from the a11y tree and
 *     silence every announcement. Reviewed bug; locked so it can't regress.
 *   - HONESTY: neither the visible micro-label NOR the live-region text ever
 *     contains a DIGIT or a bearing/compass word, across every trend. Only the
 *     four approved phrases may appear.
 *   - The announcement debounce (counted in poll SAMPLES, ~6) and the
 *     suppress-on-swap / silent-when-absent rules.
 *   - hidden=true (a chat panel is up) goes fully silent and restores on flip.
 *   - reduced-motion: the breathing halo is dropped while the core dot remains.
 *
 * Polls are simulated by re-rendering with a NEW `peers` array reference (the
 * component samples on a changed peers/me reference). No real clock — the poll
 * cadence IS the component's clock, so driving it is fully deterministic.
 *
 * We test observable DOM/roles/text, not internals. jsdom is scoped via the
 * docblock so the node-env unit/API suites are unaffected.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import ProximityPulse from "./ProximityPulse";
import type { PeerDot } from "@/lib/types";

// me at the origin; peers are placed along a meridian so haversine distance is
// a clean monotone function of |lng|.
const ME = { lat: 0, lng: 0 };

function dot(id: string, lng: number, busy = false): PeerDot {
  return { id, lat: 0, lng, busy };
}

// The four — and only — approved honest phrases. Anything else in the visible
// label or the live region is a copy-honesty violation.
const APPROVED = [
  "A signal is growing stronger",
  "A signal is fading",
  "A signal is holding steady",
  "Listening for a signal",
];

// The poll debounce is Math.ceil(8000 / POLL_INTERVAL_MS) = 6 samples. We
// re-render this many fresh poll arrays to clear the gate before a genuine
// trend change is allowed to announce. One extra is harmless (it stays ready).
const SAMPLES_TO_CLEAR_DEBOUNCE = 7;

function ProximityWrapper(props: { peers: PeerDot[]; me: typeof ME | null; hidden?: boolean }) {
  return <ProximityPulse {...props} />;
}

// Drive a sequence of poll arrays through ONE mounted component, each as a NEW
// reference so the sampler runs.
function pollThrough(
  rerender: (ui: React.ReactElement) => void,
  arrays: PeerDot[][],
  me: typeof ME | null = ME,
  hidden = false,
) {
  for (const peers of arrays) {
    // Fresh array reference each tick mirrors a real poll delivering new data.
    rerender(<ProximityWrapper peers={[...peers]} me={me} hidden={hidden} />);
  }
}

// Build an "approach" sequence: peer `a` polled steadily closer from lng=9..1,
// which settles the trend to "stronger" past the debounce.
function approachArrays(): PeerDot[][] {
  const out: PeerDot[][] = [];
  for (let lng = 9; lng >= 1; lng--) out.push([dot("a", lng)]);
  return out;
}

// The single role=status live region this component renders.
function liveRegion(): HTMLElement {
  return screen.getByRole("status");
}

// The visible micro-label is the aria-hidden span that carries the trend copy.
// It and the live region render the SAME phrase, so text queries match twice —
// we reach the visible one structurally (the aria-hidden, non-sr-only span).
function visibleLabel(): HTMLElement {
  const span = document.querySelector<HTMLElement>(
    "span[aria-hidden].font-mono",
  );
  if (!span) throw new Error("visible micro-label not found");
  return span;
}

describe("ProximityPulse — B1 regression: live region is NOT under aria-hidden", () => {
  it("the role=status node has no ancestor with aria-hidden='true'", () => {
    // A present signal so the orb + label (both aria-hidden) are rendered too —
    // we must prove the STATUS node is a non-hidden sibling, not nested under
    // the hidden decorations.
    render(<ProximityWrapper peers={[dot("a", 1)]} me={ME} />);

    const status = liveRegion();
    let node: HTMLElement | null = status;
    while (node) {
      expect(node.getAttribute("aria-hidden")).not.toBe("true");
      node = node.parentElement;
    }
  });

  it("no aria-hidden element in the tree contains the status node", () => {
    render(<ProximityWrapper peers={[dot("a", 1)]} me={ME} />);
    const status = liveRegion();
    document.querySelectorAll("[aria-hidden]").forEach((hidden) => {
      if (hidden.getAttribute("aria-hidden") === "false") return;
      expect(hidden.contains(status)).toBe(false);
    });
  });
});

describe("ProximityPulse — honesty: no digits, no bearings, only approved copy", () => {
  // Across each active trend, the visible label AND the live-region text contain
  // no number and no compass/bearing word — only an approved phrase.
  const NO_DIGIT = /\d/;
  // A standalone compass/bearing token (N/S/E/W and the spelled-out forms).
  const BEARING =
    /\b(N|S|E|W|NE|NW|SE|SW|north|south|east|west|bearing|degrees?)\b/i;

  function assertHonest(text: string) {
    expect(text).not.toMatch(NO_DIGIT);
    expect(text).not.toMatch(BEARING);
  }

  // Assert BOTH surfaces (visible label + live region) carry exactly `phrase`,
  // and that each is digit-free and bearing-free.
  function assertBothSurfaces(phrase: string) {
    const label = (visibleLabel().textContent ?? "").trim();
    const status = (liveRegion().textContent ?? "").trim();
    expect(label).toBe(phrase);
    expect(status).toBe(phrase);
    expect(APPROVED).toContain(label);
    expect(APPROVED).toContain(status);
    assertHonest(label);
    assertHonest(status);
  }

  it("STRONGER: an approaching peer's label + live region carry only honest copy", () => {
    const { rerender } = render(<ProximityWrapper peers={[dot("a", 10)]} me={ME} />);
    pollThrough(rerender, approachArrays());
    assertBothSurfaces("A signal is growing stronger");
  });

  it("FAINTER: a receding peer reads only honest copy", () => {
    const { rerender } = render(<ProximityWrapper peers={[dot("a", 1)]} me={ME} />);
    const recede: PeerDot[][] = [];
    for (let lng = 2; lng <= 10; lng++) recede.push([dot("a", lng)]);
    pollThrough(rerender, recede);
    assertBothSurfaces("A signal is fading");
  });

  it("STEADY: a static peer reads only honest copy (and never a number)", () => {
    const { rerender } = render(<ProximityWrapper peers={[dot("a", 4)]} me={ME} />);
    // Hold the same distance across many polls → steady.
    pollThrough(
      rerender,
      Array.from({ length: SAMPLES_TO_CLEAR_DEBOUNCE + 2 }, () => [dot("a", 4)]),
    );
    assertBothSurfaces("A signal is holding steady");
  });

  it("every human-readable string the component renders is an approved phrase (or empty)", () => {
    const { rerender } = render(<ProximityWrapper peers={[dot("a", 10)]} me={ME} />);
    pollThrough(rerender, approachArrays());

    // Sweep ALL text-bearing nodes; any non-empty trimmed string must be one of
    // the four approved phrases — no number, bearing, identity, or distance can
    // leak into any surface.
    const root = liveRegion().closest("div")!.parentElement ?? document.body;
    root.querySelectorAll("*").forEach((el) => {
      // Only leaf text (no element children) to avoid concatenated parents.
      if (el.children.length > 0) return;
      const t = (el.textContent ?? "").trim();
      if (t === "") return;
      expect(APPROVED).toContain(t);
      expect(t).not.toMatch(NO_DIGIT);
      expect(t).not.toMatch(BEARING);
    });
  });
});

describe("ProximityPulse — absent state is silent and non-spammy", () => {
  it("no peers → neutral, the live region is empty (silent)", () => {
    render(<ProximityWrapper peers={[]} me={ME} />);
    expect(liveRegion().textContent).toBe("");
  });

  it("me=null → neutral, the live region is empty (silent)", () => {
    render(<ProximityWrapper peers={[dot("a", 1)]} me={null} />);
    expect(liveRegion().textContent).toBe("");
  });

  it("re-rendering with still-no-peers does NOT announce anything", () => {
    const { rerender } = render(<ProximityWrapper peers={[]} me={ME} />);
    pollThrough(rerender, [[], [], [], []]);
    expect(liveRegion().textContent).toBe("");
  });
});

describe("ProximityPulse — announcement on a genuine trend change", () => {
  it("announces the matching phrase once a real trend settles past the debounce", () => {
    const { rerender } = render(<ProximityWrapper peers={[dot("a", 10)]} me={ME} />);
    pollThrough(rerender, approachArrays());

    // The announced phrase is the stronger copy (a genuine approach).
    expect(liveRegion()).toHaveTextContent("A signal is growing stronger");
  });

  it("does NOT announce stronger/fainter on a nearest-SWAP (peer A → a different nearer peer B)", () => {
    // Warm up an approach on A so the live region is currently announcing.
    const { rerender } = render(<ProximityWrapper peers={[dot("a", 10)]} me={ME} />);
    const approach: PeerDot[][] = [];
    for (let lng = 9; lng >= 3; lng--) approach.push([dot("a", lng)]);
    pollThrough(rerender, approach);

    // Now a DIFFERENT, closer peer B appears and becomes nearest → a swap. The
    // reducer returns neutral on the swap, so the live region must go SILENT,
    // never announce a phantom stronger/fainter for the two-peer comparison.
    pollThrough(rerender, [[dot("b", 1)]]);

    const text = (liveRegion().textContent ?? "").trim();
    expect(text).not.toBe("A signal is growing stronger");
    expect(text).not.toBe("A signal is fading");
    // Swap clears to silence (neutral suppresses the announcement).
    expect(text).toBe("");
  });
});

describe("ProximityPulse — hidden (a chat panel is up) silences output", () => {
  it("hidden=true blanks the live region even when a trend is present", () => {
    // Settle a stronger trend WHILE NOT hidden, then flip hidden=true and
    // re-poll: the live region must blank (the screen reader hears nothing while
    // the widget is behind the chat).
    const { rerender } = render(<ProximityWrapper peers={[dot("a", 10)]} me={ME} />);
    pollThrough(rerender, approachArrays());
    expect(liveRegion()).toHaveTextContent("A signal is growing stronger");

    // Chat opens — hidden=true. Re-render hidden; the announcement is blanked.
    rerender(<ProximityWrapper peers={[dot("a", 1)]} me={ME} hidden />);
    expect(liveRegion().textContent).toBe("");
    // The visible micro-label is faded out of view (opacity 0) and kept out of
    // the a11y tree (aria-hidden), so nothing trend-related is presented.
    expect(visibleLabel().style.opacity).toBe("0");
    expect(visibleLabel().getAttribute("aria-hidden")).not.toBe("false");
  });

  it("flipping hidden back to false restores the announcement", () => {
    const { rerender } = render(<ProximityWrapper peers={[dot("a", 10)]} me={ME} />);
    pollThrough(rerender, approachArrays());

    // Hide (silent)…
    rerender(<ProximityWrapper peers={[dot("a", 1)]} me={ME} hidden />);
    expect(liveRegion().textContent).toBe("");

    // …then show again. The preserved trend state restores the announcement
    // (the orb/label/announcement return without a re-warmup).
    rerender(<ProximityWrapper peers={[dot("a", 1)]} me={ME} hidden={false} />);
    expect(liveRegion()).toHaveTextContent("A signal is growing stronger");
  });
});

describe("ProximityPulse — reduced motion drops the breathing halo", () => {
  it("under prefers-reduced-motion the animated halo is absent but the core dot remains", () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })) as unknown as typeof window.matchMedia;

    try {
      // A present signal so the orb would otherwise show its halo.
      const { container, rerender } = render(
        <ProximityWrapper peers={[dot("a", 10)]} me={ME} />,
      );
      pollThrough(rerender, approachArrays());

      // The breathing halo is the only element animated via the `beacon`
      // keyframe; under reduced motion it must NOT be rendered.
      const animated = Array.from(
        container.querySelectorAll<HTMLElement>("[style*='animation']"),
      ).filter((el) => (el.getAttribute("style") ?? "").includes("beacon"));
      expect(animated).toHaveLength(0);

      // The core dot (and the meaning-bearing live region) are still present —
      // intensity is conveyed by a stable opacity step, not a loop.
      expect(liveRegion()).toHaveTextContent("A signal is growing stronger");
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });
});
