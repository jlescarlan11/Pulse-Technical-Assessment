/**
 * @jest-environment jsdom
 *
 * OriginStoryOverlay — component tests.
 *
 * The overlay:
 *   1. Mounts a non-interactive Mapbox map (mocked here) inside a full-screen div.
 *   2. After the map fires "load", starts a 3s auto-dismiss timer.
 *   3. A click anywhere on the overlay cancels the auto-timer and triggers dismiss.
 *   4. Dismiss is guarded by a ref so it fires AT MOST once regardless of whether
 *      click + timer both fire.
 *   5. Dismiss itself is a two-step: set `fading` state (CSS opacity-0), then after
 *      400ms call `onDismiss`.
 *
 * Timer strategy: the auto-dismiss timer is set INSIDE the map "load" callback,
 * which itself is invoked inside an async dynamic import chain. We flush the
 * microtask queue with `flushMicrotasks()` after render so the import resolves
 * and the "load" handler fires before we advance fake timers. This makes all
 * timer assertions deterministic — no arbitrary sleeps.
 *
 * Mapbox mock: mirrors the WorldMap.test.tsx pattern — `Map.on("load", cb)` fires
 * `cb` synchronously so the overlay reaches its armed state without real network.
 *
 * We test observable DOM and callback behaviour, not implementation internals.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

// --- mapbox-gl mock ----------------------------------------------------------
// Must be declared before importing the component so jest hoisting picks it up.
// The factory returns a minimal stub:
//   - Map.on("load", cb) fires cb immediately (synchronous) so the overlay's
//     init effect reaches the "armed" state without any timer trickery.
//   - Marker, LngLatBounds: stubs that return `this` for chaining.
// `setCenter`, `setZoom`, `fitBounds` are jest.fn()s so future tests could
// assert on camera calls if needed; they aren't required for the six scenarios
// but cost nothing to include.
jest.mock("mapbox-gl", () => {
  class FakeMarker {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
  }

  class FakeLngLatBounds {
    constructor(
      _sw: [number, number],
      _ne: [number, number],
    ) {}
  }

  class FakeMap {
    private _handlers: Record<string, Array<() => void>> = {};

    setCenter = jest.fn().mockReturnThis();
    setZoom = jest.fn().mockReturnThis();
    fitBounds = jest.fn().mockReturnThis();
    remove = jest.fn();

    on(event: string, cb: () => void) {
      (this._handlers[event] ??= []).push(cb);
      // Fire "load" synchronously so the overlay's init effect can set its
      // auto-dismiss timer before any fake-timer advancement in the tests.
      if (event === "load") cb();
      return this;
    }
  }

  return {
    __esModule: true,
    default: {
      accessToken: "",
      Map: FakeMap,
      Marker: FakeMarker,
      LngLatBounds: FakeLngLatBounds,
    },
  };
});

// Stub the Mapbox stylesheet import that the component pulls in for side-effects.
// jest can't parse CSS, so this must be virtual.
jest.mock("mapbox-gl/dist/mapbox-gl.css", () => ({}), { virtual: true });

// Set a truthy token so the component doesn't bail out of its init effect on
// the `if (!TOKEN || !containerRef.current) return` guard. The actual value is
// irrelevant — it's never sent to a real server in tests.
process.env.NEXT_PUBLIC_MAPBOX_TOKEN = "pk.test-token";

// Import AFTER the env var + mocks so the module-level TOKEN const is truthy.
import OriginStoryOverlay from "./OriginStoryOverlay";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The overlay's init effect is async (dynamic import("mapbox-gl")). Flushing
// the microtask queue inside act() lets the import resolve and the synchronous
// "load" callback fire — arming the auto-dismiss timer — before any fake-timer
// advancement. Two passes drain chained awaits in the effect.
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ME = { lat: 37.77, lng: -122.42 };
const PEER = { lat: 51.51, lng: -0.13 };
const PEER_COLOR = "#a78bfa";

function makeOverlay(onDismiss: jest.Mock) {
  return (
    <OriginStoryOverlay
      me={ME}
      peer={PEER}
      peerColor={PEER_COLOR}
      onDismiss={onDismiss}
    />
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OriginStoryOverlay", () => {
  beforeEach(() => {
    // Fake timers cover setTimeout / clearTimeout used by auto-dismiss and the
    // 400ms fade delay. Each test gets a clean timer state.
    jest.useFakeTimers();
  });

  afterEach(() => {
    // Restore real timers and clear any pending fake ones so tests don't bleed.
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // 1. Renders without crashing -------------------------------------------------
  it("mounts with valid props without throwing", async () => {
    const onDismiss = jest.fn();
    render(makeOverlay(onDismiss));
    await flushMicrotasks();
    // The root element is always present. If render threw, we'd never reach here.
    expect(document.body).toBeTruthy();
  });

  // 2. Map container div is in the DOM ------------------------------------------
  it("renders the map container div", async () => {
    const onDismiss = jest.fn();
    render(makeOverlay(onDismiss));
    await flushMicrotasks();

    // The overlay renders two divs: the outer (role="presentation") and the inner
    // map container (className="h-full w-full"). We verify the outer wrapper is
    // in the document — it's the div that owns the map.
    const wrapper = document.querySelector('[role="presentation"]');
    expect(wrapper).toBeInTheDocument();

    // The inner div (the mapbox container ref) should also be present.
    const inner = wrapper?.querySelector("div");
    expect(inner).toBeInTheDocument();
  });

  // 3. Auto-dismiss after 3000ms + 400ms fade -----------------------------------
  it("calls onDismiss after 3000ms (auto) + 400ms (fade)", async () => {
    const onDismiss = jest.fn();
    render(makeOverlay(onDismiss));
    await flushMicrotasks(); // drains the dynamic import; "load" fires; timer armed

    expect(onDismiss).not.toHaveBeenCalled();

    // Advance past the 3s auto-dismiss (starts the fade, sets a 400ms timer).
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(onDismiss).not.toHaveBeenCalled(); // still in the 400ms fade

    // Advance past the 400ms fade delay.
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // 4. Click dismisses early (within 400ms fade) --------------------------------
  it("calls onDismiss after clicking the overlay + 400ms fade", async () => {
    const onDismiss = jest.fn();
    render(makeOverlay(onDismiss));
    await flushMicrotasks();

    const wrapper = document.querySelector('[role="presentation"]') as HTMLElement;
    expect(wrapper).toBeInTheDocument();

    act(() => {
      fireEvent.click(wrapper);
    });
    expect(onDismiss).not.toHaveBeenCalled(); // still in the 400ms fade

    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // 5. onDismiss not called twice when click AND 3s timer both fire -------------
  it("calls onDismiss exactly once when click and auto-timer both fire", async () => {
    const onDismiss = jest.fn();
    render(makeOverlay(onDismiss));
    await flushMicrotasks();

    const wrapper = document.querySelector('[role="presentation"]') as HTMLElement;

    // Click triggers dismiss first (sets dismissedRef.current = true, cancels
    // the auto-timer). The 3s timer is now cancelled so advancing past it should
    // be a no-op; only the click's 400ms fade timer remains.
    act(() => {
      fireEvent.click(wrapper);
    });

    // Advance well past both the 3s auto and the 400ms fade — only one call expected.
    act(() => {
      jest.advanceTimersByTime(3000 + 400 + 100);
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // 6. No timer leak on unmount -------------------------------------------------
  it("cleans up timers on unmount — no pending timers after unmount", async () => {
    const onDismiss = jest.fn();
    const { unmount } = render(makeOverlay(onDismiss));
    await flushMicrotasks(); // arms the auto-dismiss timer

    // Unmount before the timer fires. The effect cleanup should clear it.
    act(() => {
      unmount();
    });

    // Running all remaining fake timers should NOT call onDismiss — the cleanup
    // cancelled the auto-dismiss timer and no fade timer was started.
    act(() => {
      jest.runAllTimers();
    });

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
