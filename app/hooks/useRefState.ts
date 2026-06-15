import { useCallback, useRef, useState } from "react";

// State paired with a ref mirror, kept in sync SYNCHRONOUSLY.
//
// Several pieces of the live page read their latest value inside long-lived
// closures — the poll interval, the presence heartbeat, the data-channel
// control handler — none of which re-subscribe when the value changes. A plain
// useState would hand those closures a stale snapshot. The established fix
// (repeated five times by hand in page.tsx) is to mirror the state into a ref
// and update both in one setter. This hook is that pattern, once.
//
// The setter writes `ref.current` BEFORE calling setState, so any code that
// reads `ref.current` immediately after a set (e.g. the next line of a signal
// handler, before React has flushed a render) sees the new value. That
// synchronous guarantee is load-bearing — connection request/accept/decline
// races depend on it.
//
// Returns a tuple `[value, ref, setValue]`: `value` for render, `ref` for
// closure reads, `setValue` to update both. The ref is seeded from `initial`
// so a fail-closed default (e.g. peerAway = true) holds from the very first
// read, before any setter runs.
export function useRefState<T>(
  initial: T,
): readonly [T, React.MutableRefObject<T>, (next: T) => void] {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef<T>(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, ref, set] as const;
}
