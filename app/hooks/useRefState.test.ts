/**
 * @jest-environment jsdom
 *
 * useRefState — the state+ref-mirror primitive that backs the page's
 * closure-safe reads. The load-bearing guarantees, verified here:
 *   1. the ref reflects the new value SYNCHRONOUSLY within the same tick as the
 *      setter call (before a render flushes), and
 *   2. the ref is seeded from `initial` so a fail-closed default holds from the
 *      first read (the peerAway = true case).
 */
import { act, renderHook } from "@testing-library/react";
import { useRefState } from "./useRefState";

describe("useRefState", () => {
  it("seeds both value and ref from initial", () => {
    const { result } = renderHook(() => useRefState<boolean>(true));
    const [value, ref] = result.current;
    expect(value).toBe(true);
    expect(ref.current).toBe(true); // fail-closed seed (peerAway) holds on mount
  });

  it("updates ref.current synchronously, before the next render reads value", () => {
    const { result } = renderHook(() => useRefState<number>(0));
    let refAtSetTime = -1;
    act(() => {
      const [, ref, setValue] = result.current;
      setValue(42);
      // Read the ref on the SAME line of execution as the setter, before React
      // has flushed a re-render. This is the guarantee the poll tick / signal
      // handlers depend on.
      refAtSetTime = ref.current;
    });
    expect(refAtSetTime).toBe(42);
    expect(result.current[0]).toBe(42); // state caught up after the flush too
  });

  it("exposes a referentially stable setter across renders", () => {
    const { result, rerender } = renderHook(() => useRefState<number>(0));
    const firstSetter = result.current[2];
    rerender();
    expect(result.current[2]).toBe(firstSetter);
  });

  it("keeps a stable ref object identity across renders", () => {
    const { result, rerender } = renderHook(() => useRefState<string>("a"));
    const firstRef = result.current[1];
    act(() => result.current[2]("b"));
    rerender();
    expect(result.current[1]).toBe(firstRef);
    expect(result.current[1].current).toBe("b");
  });
});
