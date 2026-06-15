/**
 * @jest-environment jsdom
 *
 * useBlocklist — the session-scoped, in-memory peer blocklist. Verifies the
 * orchestration over lib/blocklist.ts: block/unblock mutate the set, isBlocked
 * gates inbound requests, filterPeers excludes blocked dots from discovery, and
 * the wrapper callbacks are referentially stable (so the poll effect can list
 * filterPeers without re-subscribing).
 */
import { act, renderHook } from "@testing-library/react";
import { useBlocklist } from "./useBlocklist";
import type { PeerDot } from "@/lib/types";

const dot = (id: string): PeerDot => ({ id, lat: 0, lng: 0, busy: false });

describe("useBlocklist", () => {
  it("blocks, reports, and unblocks an id", () => {
    const { result } = renderHook(() => useBlocklist());
    expect(result.current.isBlocked("peer-1")).toBe(false);

    act(() => result.current.block("peer-1"));
    expect(result.current.isBlocked("peer-1")).toBe(true);

    act(() => result.current.unblock("peer-1"));
    expect(result.current.isBlocked("peer-1")).toBe(false);
  });

  it("filterPeers excludes blocked dots from discovery", () => {
    const { result } = renderHook(() => useBlocklist());
    act(() => result.current.block("b"));
    const filtered = result.current.filterPeers([dot("a"), dot("b"), dot("c")]);
    expect(filtered.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("exposes referentially stable callbacks across renders", () => {
    const { result, rerender } = renderHook(() => useBlocklist());
    const { block, unblock, isBlocked, filterPeers } = result.current;
    rerender();
    expect(result.current.block).toBe(block);
    expect(result.current.unblock).toBe(unblock);
    expect(result.current.isBlocked).toBe(isBlocked);
    expect(result.current.filterPeers).toBe(filterPeers);
  });
});
