/**
 * @jest-environment jsdom
 *
 * WorldMap — keyboard-accessible nearby-signals disclosure (C2) tests +
 * Phase 4 map-controls cluster (Story 1–3) tests.
 *
 * Phase 4 Story 4 — the FIRST component test for WorldMap. The map itself
 * (mapbox-gl markers / canvas) is NOT under test: it's mocked out so the
 * component mounts cleanly in jsdom. What IS tested is the plain-DOM HUD that
 * gives keyboard / screen-reader users a non-spatial path to connect, plus the
 * top-right map-controls cluster that drives the (mocked) camera:
 *
 *   - the "N signals nearby" chip is the disclosure TOGGLE (aria-expanded,
 *     aria-controls), enabled only when peers exist;
 *   - activating it opens / closes a list of peer rows, each a <button> that
 *     calls onPeerClick(id) and closes the list;
 *   - opening moves focus to the first enabled row; Escape closes and RETURNS
 *     focus to the chip (it's a disclosure, not a focus-trapped modal);
 *   - busy / !canConnect rows render but are disabled;
 *   - each row's label is the stable call-sign from lib/callsign (asserted
 *     against callSign() output, never a hardcoded string, so it can't drift);
 *   - the map-controls cluster (role="group" "Map controls") exposes four native
 *     buttons whose clicks drive map.zoomIn/zoomOut/flyTo/jumpTo/fitBounds, with
 *     unavailable state surfaced via `aria-disabled` (the buttons stay native and
 *     focusable — see the BUG-5 notes by the zoom-bound tests).
 *
 * We test observable DOM/roles + the camera calls the controls make, not
 * internals. jsdom is scoped to this file via the docblock so the node-env unit
 * / API suites are unaffected.
 *
 * NOTE on event dispatch: WorldMap binds its Escape + outside-pointerdown
 * handlers on `document` (native addEventListener), so those are dispatched at
 * the document level via fireEvent, mirroring how the real listeners fire. The
 * mapbox "zoom" event is driven through the mock's own on()/emit() mechanism
 * (mapEmit below), mirroring how Mapbox fires it on a real camera change.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { PeerDot } from "@/lib/types";
import { callSign } from "@/lib/callsign";

// --- mapbox-gl mock ---------------------------------------------------------
// The real module touches WebGL / DOM measurement that jsdom can't provide, and
// these tests never assert on the map canvas. A minimal stub lets WorldMap's
// init effect run without throwing.
//
// `Map.on("load", cb)` invokes the load callback synchronously so the component
// reaches its `ready` state (which gates the zero-peers reassurance, the
// loading veil, AND — Phase 4 — the map-controls cluster) deterministically —
// no timers, no real network.
//
// Phase 4 extensions: the zoom-bound sync effect reads getZoom/getMinZoom/
// getMaxZoom and subscribes to the live "zoom" event, and the four controls call
// zoomIn/zoomOut/flyTo/jumpTo/fitBounds. The fake therefore (a) stores every
// on() handler keyed by event so tests can EMIT "zoom" after adjusting the
// reported zoom, (b) implements the getters with test-tunable values, and (c)
// exposes the camera methods as jest.fn()s to assert on. The factory is hoisted
// above the imports by jest, so it can't close over outer test state except via
// `mock`-prefixed module variables — we capture the latest constructed map (and
// a way to emit its events) on `mockMapState` for the tests to reach.
//
// LngLatBounds is a tiny fake whose extend() records the coords it was given, so
// "frame all signals" can be asserted to include the PEER coords and exclude
// `me` without inspecting Mapbox internals.
jest.mock("mapbox-gl", () => {
  type Handler = (...args: unknown[]) => void;

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

  class FakeLngLatBounds {
    // Public so tests can read which coords were folded into the bounds.
    extended: Array<[number, number]> = [];
    extend(coord: [number, number]) {
      this.extended.push(coord);
      return this;
    }
  }

  class FakeMap {
    handlers: Record<string, Handler[]> = {};

    // Test-tunable camera state. Defaults sit comfortably between the bounds so
    // neither +/- button is disabled at first ready.
    _zoom = 2;
    _minZoom = 1;
    _maxZoom = 20;

    zoomIn = jest.fn();
    zoomOut = jest.fn();
    flyTo = jest.fn();
    jumpTo = jest.fn();
    fitBounds = jest.fn();

    constructor() {
      // Expose the most-recently-constructed instance to the test module.
      mockMapState.map = this;
    }

    on(event: string, cb: Handler) {
      (this.handlers[event] ??= []).push(cb);
      // The init effect waits on "load" to flip `ready`; fire it synchronously so
      // the controls cluster mounts without timers (matches pre-Phase-4 behaviour).
      if (event === "load") cb();
      return this;
    }
    off(event: string, cb: Handler) {
      this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== cb);
      return this;
    }
    emit(event: string) {
      (this.handlers[event] ?? []).forEach((h) => h());
    }

    getZoom() {
      return this._zoom;
    }
    getMinZoom() {
      return this._minZoom;
    }
    getMaxZoom() {
      return this._maxZoom;
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
      LngLatBounds: FakeLngLatBounds,
      NavigationControl: FakeNavigationControl,
    },
  };
});

// Bridge to reach the mocked map instance + its recorded calls from the tests.
// Must be `mock`-prefixed so jest's hoisted factory may reference it. Typed
// loosely (the fake's shape) — we only touch the bits the tests assert on.
const mockMapState: {
  map: {
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    _zoom: number;
    _minZoom: number;
    _maxZoom: number;
    zoomIn: jest.Mock;
    zoomOut: jest.Mock;
    flyTo: jest.Mock;
    jumpTo: jest.Mock;
    fitBounds: jest.Mock;
    emit: (event: string) => void;
  } | null;
} = { map: null };

// Helper: the live mocked map for the current render (throws if none yet so a
// mis-ordered test fails loudly instead of on a null deref).
function getMap() {
  if (!mockMapState.map) throw new Error("no mapbox Map constructed yet");
  return mockMapState.map;
}

// Drive a Mapbox "zoom" event after adjusting the reported camera zoom, wrapped
// in act() because it flips React state (the +/- aria-disabled flags).
function emitZoom() {
  act(() => {
    getMap().emit("zoom");
  });
}

// The component imports the Mapbox stylesheet for its side effects; jest can't
// parse CSS, so stub it to nothing.
jest.mock("mapbox-gl/dist/mapbox-gl.css", () => ({}), { virtual: true });

// The "ready"/loading path, the coach hint, AND the map-controls cluster are
// only exercised when a token is present (the no-token branch renders a "set
// your token" fallback instead). Set a dummy token before importing the
// component so its module-level `TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN`
// reads truthy.
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
// timers, no arbitrary sleeps) and keeps React's act() warning quiet. Two
// passes drain the chained awaits in the marker / me-pin effects too.
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
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

// --- map-controls cluster helpers -------------------------------------------
// The cluster is a role="group" "Map controls"; each control is a native button
// resolved by its accessible name (aria-label), the way AT would find them.
function getControls() {
  return screen.getByRole("group", { name: /map controls/i });
}
function getZoomInBtn() {
  return within(getControls()).getByRole("button", { name: /zoom in/i });
}
function getZoomOutBtn() {
  return within(getControls()).getByRole("button", { name: /zoom out/i });
}
function getRecenterBtn() {
  return within(getControls()).getByRole("button", { name: /recenter on me/i });
}
function getFrameBtn() {
  return within(getControls()).getByRole("button", { name: /frame all signals/i });
}

// sessionStorage drives the coach hint's once-per-session behaviour; reset it so
// tests don't leak state into one another. Also reset the captured map handle so
// each test reads the instance it just rendered.
beforeEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
  mockMapState.map = null;
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

// ---------------------------------------------------------------------------
// Phase 4 — map-controls cluster (Story 1–3).
// We test the OBSERVABLE behaviour: which controls exist, their accessible
// names + aria-disabled state, and which (mocked) camera method each click
// drives. We never assert on Mapbox internals — only the public camera API the
// controls call, and (for "frame all signals") the coords folded into the
// LngLatBounds.
//
// NB: the four controls use `aria-disabled` (NOT the native `disabled` attr) so
// they stay focusable and in the tab order — see the BUG-5 tests below for why.
// React renders aria-disabled={true} as the string "true" and aria-disabled=
// {false} as "false" (it is never omitted), so the assertions read the attribute
// value directly rather than using `.toBeDisabled()`.
// ---------------------------------------------------------------------------
describe("WorldMap map-controls cluster (Phase 4)", () => {
  // --- gating on ready / token ---------------------------------------------
  it("renders the four controls (by accessible name) once the map is ready", async () => {
    await renderMap();

    const group = getControls();
    expect(group).toBeInTheDocument();
    // All four present, each a native button addressable by its aria-label.
    expect(
      within(group).getByRole("button", { name: /zoom in/i }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole("button", { name: /zoom out/i }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole("button", { name: /recenter on me/i }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole("button", { name: /frame all signals/i }),
    ).toBeInTheDocument();
  });

  it("does not render the cluster before the map is ready, then mounts it once ready", async () => {
    // The async init effect hasn't resolved synchronously after render, so
    // `ready` is still false and the (ready-gated) cluster must be absent —
    // consistent with how the loading veil gates on the same flag. We then flush
    // microtasks so the mocked "load" flips `ready`, and the cluster appears —
    // proving the gate, and settling the pending state update inside act().
    render(
      <WorldMap peers={PEERS} me={ME} onPeerClick={jest.fn()} canConnect />,
    );
    // Pre-ready: absent.
    expect(
      screen.queryByRole("group", { name: /map controls/i }),
    ).not.toBeInTheDocument();

    // Let the init effect resolve and flip `ready` (deterministic, no timers).
    await flushMicrotasks();

    // Post-ready: present.
    expect(
      screen.getByRole("group", { name: /map controls/i }),
    ).toBeInTheDocument();
  });

  // --- Story 1: zoom in / out ----------------------------------------------
  it("drives map.zoomIn() on Zoom in and map.zoomOut() on Zoom out", async () => {
    await renderMap();
    const map = getMap();

    fireEvent.click(getZoomInBtn());
    expect(map.zoomIn).toHaveBeenCalledTimes(1);
    expect(map.zoomOut).not.toHaveBeenCalled();

    fireEvent.click(getZoomOutBtn());
    expect(map.zoomOut).toHaveBeenCalledTimes(1);
  });

  it("marks Zoom in aria-disabled at the max-zoom bound and Zoom out aria-disabled at the min-zoom bound, driven by the map 'zoom' event", async () => {
    await renderMap();
    const map = getMap();

    // Mid-range to start: neither bound reached. React renders the falsy flag as
    // the string "false" (never omitted), so assert that explicitly.
    expect(getZoomInBtn()).toHaveAttribute("aria-disabled", "false");
    expect(getZoomOutBtn()).toHaveAttribute("aria-disabled", "false");

    // Camera reports it is at (within epsilon of) max zoom, then fires "zoom".
    map._zoom = map._maxZoom;
    emitZoom();
    expect(getZoomInBtn()).toHaveAttribute("aria-disabled", "true");
    // Out is still available at the top.
    expect(getZoomOutBtn()).toHaveAttribute("aria-disabled", "false");

    // Now sitting at the min bound: "+" frees up, "-" locks.
    map._zoom = map._minZoom;
    emitZoom();
    expect(getZoomInBtn()).toHaveAttribute("aria-disabled", "false");
    expect(getZoomOutBtn()).toHaveAttribute("aria-disabled", "true");
  });

  it("locks the bound buttons (aria-disabled) within the 0.01 epsilon (fractionally short of the hard stop)", async () => {
    await renderMap();
    const map = getMap();

    // Mapbox lands a hair short of the exact max after a wheel/pinch; the button
    // must still read as aria-disabled at the practical limit.
    map._zoom = map._maxZoom - 0.005; // inside the 0.01 epsilon
    emitZoom();
    expect(getZoomInBtn()).toHaveAttribute("aria-disabled", "true");

    // A clear margin outside the epsilon stays available.
    map._zoom = map._maxZoom - 1;
    emitZoom();
    expect(getZoomInBtn()).toHaveAttribute("aria-disabled", "false");
  });

  // --- Story 1: zoom bounds keep focus (aria-disabled, BUG-5 resolved) ------
  // The aria-disabled choice exists to FIX BUG-5: a native-`disabled` button that
  // disables itself WHILE holding keyboard focus makes the browser synchronously
  // blur it to <body>, ejecting the keyboard user from the cluster. An
  // aria-disabled button stays focusable and in the tab order, so focus is never
  // dropped — and the click handler no-ops at the bound instead. These two tests
  // are the positive proof of that contract.
  it("keeps the Zoom in button focusable and does NOT lose focus when it reaches the max-zoom bound (aria-disabled, BUG-5 resolved)", async () => {
    await renderMap();
    const map = getMap();

    const zoomIn = getZoomInBtn();
    // Precondition: enabled (aria-disabled false) and actually holding focus.
    expect(zoomIn).toHaveAttribute("aria-disabled", "false");
    zoomIn.focus();
    expect(document.activeElement).toBe(zoomIn);

    // Drive to max and fire "zoom" so atMaxZoom flips and aria-disabled becomes
    // "true". The button is NOT natively disabled, so the browser/jsdom never
    // blurs it — focus must stay put.
    map._zoom = map._maxZoom;
    emitZoom();

    const zoomInAfter = getZoomInBtn();
    expect(zoomInAfter).toHaveAttribute("aria-disabled", "true");
    // The whole point of BUG-5's fix: focus is STILL on Zoom in, not on <body>.
    expect(document.activeElement).toBe(zoomInAfter);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("keeps the Zoom out button focusable and does NOT lose focus when it reaches the min-zoom bound (aria-disabled, BUG-5 resolved, symmetric)", async () => {
    await renderMap();
    const map = getMap();

    const zoomOut = getZoomOutBtn();
    expect(zoomOut).toHaveAttribute("aria-disabled", "false");
    zoomOut.focus();
    expect(document.activeElement).toBe(zoomOut);

    map._zoom = map._minZoom;
    emitZoom();

    const zoomOutAfter = getZoomOutBtn();
    expect(zoomOutAfter).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(zoomOutAfter);
    expect(document.activeElement).not.toBe(document.body);
  });

  // --- Story 1: at-bound clicks are no-ops (handler early-return) -----------
  // aria-disabled buttons stay activatable, so the SAFETY is in the handler:
  // zoomIn() early-returns when atMaxZoom, zoomOut() when atMinZoom. Clicking the
  // button at the bound must therefore NOT reach the (mocked) camera method.
  it("does not zoom past the bound: clicking Zoom in at max zoom is a no-op", async () => {
    await renderMap();
    const map = getMap();

    // Drive to max so atMaxZoom is true (Zoom in is aria-disabled).
    map._zoom = map._maxZoom;
    emitZoom();
    expect(getZoomInBtn()).toHaveAttribute("aria-disabled", "true");

    // The button is still clickable, but the handler early-returns at the bound.
    fireEvent.click(getZoomInBtn());
    expect(map.zoomIn).not.toHaveBeenCalled();
  });

  it("does not zoom past the bound: clicking Zoom out at min zoom is a no-op (symmetric)", async () => {
    await renderMap();
    const map = getMap();

    map._zoom = map._minZoom;
    emitZoom();
    expect(getZoomOutBtn()).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(getZoomOutBtn());
    expect(map.zoomOut).not.toHaveBeenCalled();
  });

  // --- Story 2: recenter on me ---------------------------------------------
  it("marks Recenter aria-disabled when there is no fix (me is null)", async () => {
    await renderMap({ me: null });
    expect(getRecenterBtn()).toHaveAttribute("aria-disabled", "true");
  });

  it("flies to the user's coordinate (peers untouched) when Recenter is clicked with a fix", async () => {
    await renderMap();
    const map = getMap();

    expect(getRecenterBtn()).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(getRecenterBtn());

    expect(map.flyTo).toHaveBeenCalledTimes(1);
    // Centered on [me.lng, me.lat] — the observable contract; zoom is a sane fix
    // altitude (asserted positive rather than pinned to a magic number).
    const arg = map.flyTo.mock.calls[0][0] as {
      center: [number, number];
      zoom: number;
    };
    expect(arg.center).toEqual([ME.lng, ME.lat]);
    expect(arg.zoom).toBeGreaterThan(0);
    // Default (no reduced motion): jumpTo is NOT used.
    expect(map.jumpTo).not.toHaveBeenCalled();
  });

  it("jumps (no animation) instead of flying under prefers-reduced-motion", async () => {
    // Scoped matchMedia mock: report reduce=true ONLY for the reduced-motion
    // query. Installed for this test and torn down in finally so it can't leak
    // into the deterministic default-motion assertions above/below.
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
      await renderMap();
      const map = getMap();

      fireEvent.click(getRecenterBtn());

      // Under reduced motion the camera jumps (no JS animation), not flies.
      expect(map.jumpTo).toHaveBeenCalledTimes(1);
      expect(map.flyTo).not.toHaveBeenCalled();
      const arg = map.jumpTo.mock.calls[0][0] as { center: [number, number] };
      expect(arg.center).toEqual([ME.lng, ME.lat]);
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  // --- Story 3: frame all signals ------------------------------------------
  it("marks Frame all signals aria-disabled when there are no peers", async () => {
    await renderMap({ peers: [] });
    expect(getFrameBtn()).toHaveAttribute("aria-disabled", "true");
  });

  it("fits bounds to the PEER coordinates only (excluding me) when Frame is clicked", async () => {
    await renderMap();
    const map = getMap();

    expect(getFrameBtn()).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(getFrameBtn());
    await flushMicrotasks(); // frameAllSignals awaits the dynamic mapbox import

    expect(map.fitBounds).toHaveBeenCalledTimes(1);

    // First arg is the LngLatBounds we built. The fake records every coord it was
    // extend()ed with; read those and assert PEERS-ONLY: every peer coord is in,
    // and the `me` coord is NOT — the "where the souls are" contract.
    const bounds = map.fitBounds.mock.calls[0][0] as {
      extended: Array<[number, number]>;
    };
    const coords = bounds.extended.map((c) => `${c[0]},${c[1]}`);

    for (const peer of PEERS) {
      expect(coords).toContain(`${peer.lng},${peer.lat}`);
    }
    expect(coords).toHaveLength(PEERS.length);
    expect(coords).not.toContain(`${ME.lng},${ME.lat}`);

    // Second arg carries the coincident-point clamp: a finite maxZoom so a single
    // / coincident peer lands at a sane altitude instead of slamming to max.
    const opts = map.fitBounds.mock.calls[0][1] as {
      maxZoom: number;
      padding: unknown;
    };
    expect(opts.maxZoom).toBeGreaterThan(0);
    expect(opts.padding).toBeDefined();
  });

  it("still passes a maxZoom clamp when framing exactly one peer (the coincident-point case)", async () => {
    const onePeer: PeerDot[] = [{ id: "peer-solo", lat: 5, lng: 6, busy: false }];
    await renderMap({ peers: onePeer });
    const map = getMap();

    expect(getFrameBtn()).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(getFrameBtn());
    await flushMicrotasks();

    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    const opts = map.fitBounds.mock.calls[0][1] as { maxZoom: number };
    // The clamp is what stops a no-spread single point tunnelling to max zoom.
    expect(opts.maxZoom).toBeGreaterThan(0);
    expect(Number.isFinite(opts.maxZoom)).toBe(true);
  });

  // --- Story 3: frame all signals — BUG-4 antimeridian shortest arc --------
  // Regression for BUG-4: two peers straddling the 180/-180 seam used to fold
  // their RAW longitudes into LngLatBounds, reading as a ~358° span so fitBounds
  // zoomed out around the whole globe the long way. The fix unwraps each peer's
  // lng relative to the first peer (peers[0]) so the pair sits within 180° of
  // each other — the short arc. We assert the coords the FakeLngLatBounds
  // recorded via extend() span <=180° (here ~2°), latitudes pass through
  // unchanged, and `me` is still excluded — reusing the same `.extended`
  // mechanism the peers-only test reads.
  it("frames the SHORT arc across the antimeridian (BUG-4): unwraps peer lngs to within 180°", async () => {
    // A at +179, B at -179: raw span is 358° (the long way). The fix must shift
    // one of them by 360 so the pair becomes e.g. [179, 181] — a 2° span.
    const straddle: PeerDot[] = [
      { id: "peer-east", lat: 10, lng: 179, busy: false },
      { id: "peer-west", lat: -10, lng: -179, busy: false },
    ];
    await renderMap({ peers: straddle });
    const map = getMap();

    expect(getFrameBtn()).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(getFrameBtn());
    await flushMicrotasks(); // frameAllSignals awaits the dynamic mapbox import

    expect(map.fitBounds).toHaveBeenCalledTimes(1);

    const bounds = map.fitBounds.mock.calls[0][0] as {
      extended: Array<[number, number]>;
    };

    // One extend() per peer (me excluded), same as the peers-only contract.
    expect(bounds.extended).toHaveLength(straddle.length);

    const lngs = bounds.extended.map((c) => c[0]);
    const lats = bounds.extended.map((c) => c[1]);

    // THE BUG-4 ASSERTION: the unwrapped longitudes span the SHORT arc — within
    // 180° of each other (here ~2°), NOT the naive 358° wrap.
    const span = Math.max(...lngs) - Math.min(...lngs);
    expect(span).toBeLessThanOrEqual(180);
    expect(span).toBeCloseTo(2, 5);

    // The reference peer (peers[0]) is left as-is; the other is shifted by 360.
    // Concretely the pair is [179, 181] (-179 unwrapped to +181). Order in the
    // extended array follows the peers array, so assert by membership not index.
    expect(lngs).toContain(179);
    expect(lngs).toContain(181);

    // Latitudes pass through unchanged (the unwrap only touches longitude).
    expect(lats).toContain(10);
    expect(lats).toContain(-10);

    // Still peers-only — `me`'s coord is never folded into the bounds.
    const coords = bounds.extended.map((c) => `${c[0]},${c[1]}`);
    expect(coords).not.toContain(`${ME.lng},${ME.lat}`);
  });

  // --- accessibility -------------------------------------------------------
  it("exposes each control as a native button with the correct accessible name", async () => {
    await renderMap();
    const group = getControls();

    const names = ["Zoom in", "Zoom out", "Recenter on me", "Frame all signals"];
    for (const name of names) {
      const btn = within(group).getByRole("button", { name });
      // Native <button> (so keyboard + Enter/Space + the global focus ring work).
      expect(btn.tagName).toBe("BUTTON");
      expect(btn).toHaveAttribute("type", "button");
    }
  });

  it("surfaces unavailable state via aria-disabled (never the native disabled attr), staying a focusable native button", async () => {
    // No peers + no fix → both context-gated controls are unavailable. The
    // contract: they expose that via `aria-disabled="true"` to AT, but are NEVER
    // natively `disabled` (so they keep focus and tab order — BUG-5). The two
    // always-available zoom buttons report aria-disabled="false" here (mid-range
    // camera, neither bound reached).
    await renderMap({ peers: [], me: null });
    const group = getControls();

    const recenter = within(group).getByRole("button", {
      name: /recenter on me/i,
    });
    const frame = within(group).getByRole("button", {
      name: /frame all signals/i,
    });

    // Unavailable → aria-disabled "true", and NOT natively disabled.
    for (const btn of [recenter, frame]) {
      expect(btn).toHaveAttribute("aria-disabled", "true");
      expect(btn).not.toHaveAttribute("disabled");
      expect(btn).not.toBeDisabled();
      // Still a real, focusable native button.
      expect(btn.tagName).toBe("BUTTON");
      expect(btn).toHaveAttribute("type", "button");
    }

    // The zoom pair is available here → aria-disabled "false", also never native.
    for (const btn of [getZoomInBtn(), getZoomOutBtn()]) {
      expect(btn).toHaveAttribute("aria-disabled", "false");
      expect(btn).not.toHaveAttribute("disabled");
      expect(btn.tagName).toBe("BUTTON");
    }
  });
});
