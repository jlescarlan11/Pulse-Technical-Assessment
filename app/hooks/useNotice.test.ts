/**
 * @jest-environment jsdom
 *
 * useNotice — the transient toast + terminal notice + Block→Undo focus net.
 * The load-bearing guarantees, verified here:
 *   - showNotice is referentially STABLE (R5): the [conn, showNotice] expiry
 *     effect must not re-subscribe every render.
 *   - auto-dismiss windows differ for plain vs action notices, and a newer
 *     notice supersedes an older one's timer (nonce).
 *   - the focus net (R6): focus moves to the Undo button when an action notice
 *     mounts, and returns to main only when the hook placed it.
 */
import { act, renderHook } from "@testing-library/react";
import { useNotice } from "./useNotice";

// rAF/cancel are used by the focus effect; drive them synchronously.
beforeEach(() => {
  jest
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("useNotice", () => {
  it("exposes a referentially stable showNotice across renders (R5)", () => {
    const { result, rerender } = renderHook(() => useNotice());
    const first = result.current.showNotice;
    rerender();
    expect(result.current.showNotice).toBe(first);
  });

  it("shows a transient notice and auto-dismisses at the plain window", () => {
    jest.useFakeTimers();
    try {
      const { result } = renderHook(() => useNotice());
      act(() => result.current.showNotice("Video declined."));
      expect(result.current.notice?.text).toBe("Video declined.");
      act(() => jest.advanceTimersByTime(3500));
      expect(result.current.notice).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("gives an action notice the longer window and survives the plain window", () => {
    jest.useFakeTimers();
    try {
      const { result } = renderHook(() => useNotice());
      act(() =>
        result.current.showNotice("Blocked", {
          action: { label: "Undo", onAct: () => {} },
          assertive: true,
        }),
      );
      act(() => jest.advanceTimersByTime(3500));
      expect(result.current.notice?.text).toBe("Blocked"); // still up past 3.5s
      act(() => jest.advanceTimersByTime(2500));
      expect(result.current.notice).toBeNull(); // cleared at 6s
    } finally {
      jest.useRealTimers();
    }
  });

  it("lets a newer notice supersede an older one's timer (nonce)", () => {
    jest.useFakeTimers();
    try {
      const { result } = renderHook(() => useNotice());
      act(() => result.current.showNotice("first"));
      act(() => jest.advanceTimersByTime(2000));
      act(() => result.current.showNotice("second"));
      // The first notice's 3.5s timer would fire here, but the nonce guard
      // means it must NOT clear the newer notice.
      act(() => jest.advanceTimersByTime(1500));
      expect(result.current.notice?.text).toBe("second");
    } finally {
      jest.useRealTimers();
    }
  });

  it("terminal notice clears any in-flight transient toast", () => {
    const { result } = renderHook(() => useNotice());
    act(() => result.current.showNotice("transient"));
    act(() => result.current.showTerminalNotice("Session expired."));
    expect(result.current.terminalNotice).toBe("Session expired.");
    expect(result.current.notice).toBeNull();
  });

  it("moves focus to Undo on an action notice and back to main on dismiss (R6)", () => {
    const { result } = renderHook(() => useNotice());
    const undo = document.createElement("button");
    const main = document.createElement("div");
    main.tabIndex = -1;
    document.body.append(undo, main);
    // Wire the refs the way the render does.
    act(() => {
      result.current.undoRef.current = undo;
      result.current.mainRef.current = main;
    });

    act(() =>
      result.current.showNotice("Blocked", {
        action: { label: "Undo", onAct: () => {} },
        assertive: true,
      }),
    );
    expect(document.activeElement).toBe(undo); // focus placed on Undo

    act(() => result.current.dismissNotice());
    expect(document.activeElement).toBe(main); // returned to main (we placed it)
  });

  it("re-targets focus to the NEW Undo when a second action notice supersedes the first", () => {
    const { result } = renderHook(() => useNotice());
    const undoA = document.createElement("button");
    const undoB = document.createElement("button");
    const main = document.createElement("div");
    main.tabIndex = -1;
    document.body.append(undoA, undoB, main);
    act(() => {
      result.current.mainRef.current = main;
    });

    // First action notice → focus lands on Undo A.
    act(() => {
      result.current.undoRef.current = undoA;
      result.current.showNotice("Blocked A", {
        action: { label: "Undo", onAct: () => {} },
        assertive: true,
      });
    });
    expect(document.activeElement).toBe(undoA);

    // A second action notice (new nonce) replaces it → focus must move to Undo B,
    // not stay stranded on the removed Undo A. This is why the focus effect is
    // keyed on the notice nonce, not merely "has an action".
    act(() => {
      result.current.undoRef.current = undoB;
      result.current.showNotice("Blocked B", {
        action: { label: "Undo", onAct: () => {} },
        assertive: true,
      });
    });
    expect(document.activeElement).toBe(undoB);
  });

  it("does not yank focus for a plain (non-action) notice", () => {
    const { result } = renderHook(() => useNotice());
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    act(() => result.current.showNotice("Video declined."));
    expect(document.activeElement).toBe(elsewhere); // untouched
  });
});
