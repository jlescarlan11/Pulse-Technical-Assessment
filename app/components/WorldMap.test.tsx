/**
 * @jest-environment jsdom
 *
 * WorldMap — keyboard-accessible nearby-signals disclosure (C2) tests.
 *
 * Phase 4 Story 4 — the FIRST component test for WorldMap. The map itself
 * (mapbox-gl markers / canvas) is NOT under test: it's mocked out so the
 * component mounts cleanly in jsdom. What IS tested is the plain-DOM HUD that
 * gives keyboard / screen-reader users a non-spatial path to connect:
 *
 *   - the "N signals nearby" chip is the disclosure TOGGLE (aria-expanded,
 *     aria-controls), enabled only when peers exist;
 *   - activating it opens / closes a list of peer rows, each a <button> that
 *     calls onPeerClick(id) and closes the list;
 *   - opening moves focus to the first enabled row; Escape closes and RETURNS
 *     focus to the chip (it's a disclosure, not a focus-trapped modal);
 *   - busy / !canConnect rows render but are disabled;
 *   - each row's label is the stable call-sign from lib/callsign (asserted
 *     against callSign() output, never a hardcoded string, so it can't drift).
 *
 * We test observable DOM/roles, not internals. jsdom is scoped to this file via
 * the docblock so the node-env unit / API suites are unaffected.
 *
 * NOTE on event dispatch: WorldMap binds its Escape + outside-pointerdown
 * handlers on `document` (native addEventListener), so those are dispatched at
 * the document level via fireEvent, mirroring how the real listeners fire.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { PeerDot } from "@/lib/types";
import { callSign } from "@/lib/callsign";

// --- mapbox-gl mock ---------------------------------------------------------
// The real module touches WebGL / DOM measurement that jsdom can't provide, and
// these tests never assert on the map canvas. A minimal stub lets WorldMap's
// init effect run without throwing. `Map.on("load", cb)` invokes the load
// callback synchronously so the component reaches its `ready` state (which gates
// the zero-peers reassurance + clears the loading veil) deterministically — no
// timers, no real network.
jest.mock("mapbox-gl", () => {
  class FakeMarker {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      return this;
    }
    getElement() {
      return document.createElement("button");
    }
  }
  class FakeMap {
    on(event: string, cb: () => void) {
      if (event === "load") cb();
      return this;
    }
    addControl() {
      return this;
    }
    remove() {
      return this;
    }
    setCenter() {
      return this;
    }
  }
  class FakeNavigationControl {}
  return {
    __esModule: true,
    default: {
      // WorldMap assigns accessToken on the default export before constructing.
      accessToken: "",
      Map: FakeMap,
      Marker: FakeMarker,
      NavigationControl: FakeNavigationControl,
    },
  };
});

// The component imports the Mapbox stylesheet for its side effects; jest can't
// parse CSS, so stub it to nothing.
jest.mock("mapbox-gl/dist/mapbox-gl.css", () => ({}), { virtual: true });

// The "ready"/loading path and the coach hint are only exercised when a token
// is present (the no-token branch renders a "set your token" fallback instead).
// Set a dummy token before importing the component so its module-level
// `TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN` reads truthy.
process.env.NEXT_PUBLIC_MAPBOX_TOKEN = "pk.test-token";

// Imported AFTER the env var + mocks so the module-level TOKEN const is truthy.
import WorldMap from "./WorldMap";

// --- fixtures ---------------------------------------------------------------
// Three peers with distinct ids so their call-signs are independently asserted.
// "peer-busy" is busy (its row is disabled regardless of canConnect).
const PEERS: PeerDot[] = [
  { id: "peer-alpha", lat: 10, lng: 20, busy: false },
  { id: "peer-bravo", lat: 11, lng: 21, busy: false },
  { id: "peer-busy", lat: 12, lng: 22, busy: true },
];

const ME = { lat: 1, lng: 2 };

// WorldMap's map-init effect is async (it `await`s `import("mapbox-gl")` then
// calls setReady on the mocked map's synchronous "load"). Flushing the
// microtask queue inside act() lets that state settle deterministically (no
// timers, no arbitrary sleeps) and keeps React's act() warning quiet.
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderMap(over: Partial<React.ComponentProps<typeof WorldMap>> = {}) {
  const onPeerClick = over.onPeerClick ?? jest.fn();
  const utils = render(
    <WorldMap
      peers={PEERS}
      me={ME}
      onPeerClick={onPeerClick}
      canConnect={true}
      {...over}
    />,
  );
  await flushMicrotasks();
  return { ...utils, onPeerClick };
}

// The chip is the disclosure toggle. With peers present its accessible name is
// "N signals nearby — open list to connect"; we match the stable leading phrase.
function getChip() {
  return screen.getByRole("button", { name: /signals? nearby/i });
}

// The disclosure list is found via the chip's aria-controls (the useId list),
// matching how an assistive tech would resolve it rather than a brittle class.
function getList() {
  const id = getChip().getAttribute("aria-controls");
  if (!id) throw new Error("chip has no aria-controls — list is not open");
  const el = document.getElementById(id);
  if (!el) throw new Error(`aria-controls target #${id} not in the document`);
  return el;
}

// sessionStorage drives the coach hint's once-per-session behaviour; reset it so
// tests don't leak state into one another.
beforeEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("WorldMap nearby-signals disclosure (C2)", () => {
  it("opens and closes the list when the chip is activated", async () => {
    await renderMap();
    const chip = getChip();

    // Closed initially: no aria-controls, collapsed.
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip).not.toHaveAttribute("aria-controls");

    // Open.
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const list = getList();
    expect(list).toBeInTheDocument();
    expect(within(list).getByText("Nearby signals")).toBeInTheDocument();

    // Close again (toggle).
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip).not.toHaveAttribute("aria-controls");
  });

  it("moves focus to the first enabled row on open; disabled rows are present but not activatable", async () => {
    const { onPeerClick } = await renderMap();
    const chip = getChip();

    fireEvent.click(chip);
    const list = getList();
    const rows = within(list).getAllByRole("button");

    // One row per peer.
    expect(rows).toHaveLength(PEERS.length);

    // Focus landed inside the disclosure, on the first ENABLED row (peer-alpha).
    const firstEnabled = within(list).getByRole("button", {
      name: new RegExp(`^${callSign("peer-alpha")} — `),
    });
    expect(document.activeElement).toBe(firstEnabled);

    // The busy peer's row exists but is disabled, and clicking it does nothing.
    const busyRow = within(list).getByRole("button", {
      name: new RegExp(`^${callSign("peer-busy")} — `),
    });
    expect(busyRow).toBeDisabled();
    fireEvent.click(busyRow);
    expect(onPeerClick).not.toHaveBeenCalled();
  });

  it("closes the list and returns focus to the chip on Escape", async () => {
    await renderMap();
    const chip = getChip();

    fireEvent.click(chip);
    expect(getChip()).toHaveAttribute("aria-expanded", "true");

    // Escape is bound on document (native listener), so dispatch it there.
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    // List collapsed AND focus returned to the chip (disclosure contract).
    const chipAfter = getChip();
    expect(chipAfter).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(chipAfter);
  });

  it("calls onPeerClick once with the row's peer id and closes the list on row activation", async () => {
    const { onPeerClick } = await renderMap();
    const chip = getChip();

    fireEvent.click(chip);
    const list = getList();
    const row = within(list).getByRole("button", {
      name: new RegExp(`^${callSign("peer-bravo")} — `),
    });

    fireEvent.click(row);

    expect(onPeerClick).toHaveBeenCalledTimes(1);
    expect(onPeerClick).toHaveBeenCalledWith("peer-bravo");
    // Selecting a row collapses the disclosure.
    expect(getChip()).toHaveAttribute("aria-expanded", "false");
  });

  it("labels each row with the peer's stable call-sign from lib/callsign", async () => {
    await renderMap();
    fireEvent.click(getChip());
    const list = getList();

    // Assert against callSign() output (not a hardcoded handle) so the test can't
    // drift if the wordlists change — only the contract "row shows callSign(id)".
    for (const peer of PEERS) {
      const sign = callSign(peer.id);
      // The visible handle is rendered (it also appears as the swatch sr-only
      // referent, so >=1 match is the honest assertion).
      expect(within(list).getAllByText(sign).length).toBeGreaterThan(0);
      // And it anchors that row's accessible name.
      expect(
        within(list).getByRole("button", { name: new RegExp(`^${sign} — `) }),
      ).toBeInTheDocument();
    }

    // Same id -> same handle: peer-alpha's sign is identical wherever it shows.
    const alphaSign = callSign("peer-alpha");
    const alphaCells = within(list).getAllByText(alphaSign);
    expect(alphaCells.every((el) => el.textContent === alphaSign)).toBe(true);
  });

  it("disables every row (none activatable) when canConnect is false", async () => {
    const { onPeerClick } = await renderMap({ canConnect: false });
    fireEvent.click(getChip());
    const list = getList();
    const rows = within(list).getAllByRole("button");

    expect(rows).toHaveLength(PEERS.length);
    for (const row of rows) {
      expect(row).toBeDisabled();
    }
    // None can be activated.
    rows.forEach((row) => fireEvent.click(row));
    expect(onPeerClick).not.toHaveBeenCalled();
  });

  it("disables the chip and opens no list when there are zero peers", async () => {
    await renderMap({ peers: [] });
    const chip = screen.getByRole("button", { name: /no signals nearby/i });

    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("aria-expanded", "false");

    // Activating the disabled chip must not open a disclosure.
    fireEvent.click(chip);
    expect(chip).not.toHaveAttribute("aria-controls");
    expect(screen.queryByText("Nearby signals")).not.toBeInTheDocument();
  });
});
