import { useCallback, useEffect, useRef, useState } from "react";

// Auto-dismiss windows for the transient confirmation toast (showNotice).
// A plain toast clears at NOTICE_MS; one carrying an action (e.g. Block's Undo)
// gets NOTICE_ACTION_MS — a longer, calmer window to reach the control.
const NOTICE_MS = 3500;
const NOTICE_ACTION_MS = 6000;

export type NoticeAction = { label: string; onAct: () => void };
export type Notice = {
  text: string;
  action?: NoticeAction;
  assertive?: boolean;
  nonce: number;
};

export interface UseNotice {
  // Transient confirmation toast (or null when none is showing).
  notice: Notice | null;
  // Terminal / unrecoverable notice — persists until the user reloads.
  terminalNotice: string | null;
  // Show a transient toast. Referentially STABLE (see below).
  showNotice: (
    text: string,
    opts?: { action?: NoticeAction; assertive?: boolean },
  ) => void;
  // Dismiss the transient toast now (clears its timer, returns focus).
  dismissNotice: () => void;
  // Raise the terminal notice; clears any in-flight transient toast first so the
  // two can never overlap at the same screen slot.
  showTerminalNotice: (text: string) => void;
  // Wire to the Undo button (focus target) and the main/map region (focus return).
  undoRef: React.MutableRefObject<HTMLButtonElement | null>;
  mainRef: React.MutableRefObject<HTMLElement | null>;
}

// The page's notice/toast system, extracted whole.
//
// Owns the transient confirmation toast, the terminal (unrecoverable) notice,
// and the Block→Undo focus safety net. The render keeps the JSX (live regions +
// visible toast) and reads `notice`/`terminalNotice` from here; callers raise
// notices via `showNotice` / `showTerminalNotice`.
//
// A11y: the toast lives in a PERSISTENT live region (always-mounted container;
// only its inner content swaps), so an announcement fires on each empty→full
// content change rather than racing the region's own mount. The optional
// `assertive` flag promotes the announcement to assertive/role=alert for the
// result of a destructive action (Block/Undo) while routine notices (e.g.
// "Video declined") stay polite.
export function useNotice(): UseNotice {
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeNonce = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Focus management for the Block→Undo safety net. After blockPeer(),
  // teardown() unmounts ChatPanel and the focused Block button is destroyed,
  // so focus would fall to <body> and the keyboard/SR user would have to
  // blind-tab to find Undo within the 6s window. Instead we move focus to the
  // Undo button when an action notice mounts (undoRef), and return focus to the
  // map/main region (mainRef) on dismiss/timeout/after-Undo so it never rests
  // on a removed node. A ref-flag tracks whether WE moved focus, so we only
  // pull it back when we were the ones who placed it.
  const undoRef = useRef<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const movedFocusForNotice = useRef(false);
  // Terminal (unrecoverable) notice — distinct from the transient confirmation
  // toast: it persists until the user acts (Reload) rather than auto-dismissing.
  // Kept separate so showNotice()'s 3.5s path stays untouched.
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);

  // Show a transient toast. Pass an `action` to attach a single inline button
  // (e.g. Undo) and `assertive` to promote the announcement for a destructive
  // result. Re-arms a single shared timer so a newer notice always wins and an
  // older one can't dismiss it early. Acting on (or being replaced) clears it.
  // Wrapped in useCallback so it's a stable reference: it's read inside the
  // incoming-prompt-expiry effect ([conn]) and we don't want that effect to
  // re-subscribe on every render. It closes only over stable refs + setNotice,
  // so an empty dep list is correct.
  const showNotice = useCallback(
    (
      text: string,
      opts?: { action?: NoticeAction; assertive?: boolean },
    ) => {
      const action = opts?.action;
      const assertive = opts?.assertive;
      const nonce = ++noticeNonce.current;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      setNotice({ text, action, assertive, nonce });
      noticeTimer.current = setTimeout(
        () => {
          // Only clear if no newer notice has superseded this one.
          if (noticeNonce.current === nonce) setNotice(null);
        },
        action ? NOTICE_ACTION_MS : NOTICE_MS,
      );
    },
    [],
  );

  // Return focus to the main/map region — but ONLY if we were the ones who
  // moved it onto the toast (so we never yank focus from wherever the user
  // legitimately put it). Used on dismiss, timeout, and after Undo fires.
  function returnFocusToMain() {
    if (movedFocusForNotice.current) {
      movedFocusForNotice.current = false;
      mainRef.current?.focus();
    }
  }

  function dismissNotice() {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    returnFocusToMain();
    setNotice(null);
  }

  // Raise the terminal notice. The terminal notice takes precedence over any
  // transient toast that may be mid-flight (both share the top-6 z-50 slot), so
  // clear the transient notice first — the two can never overlap at the same
  // coordinate.
  const showTerminalNotice = useCallback((text: string) => {
    setNotice(null);
    setTerminalNotice(text);
  }, []);

  // When an ACTION notice (the Block→Undo toast) mounts, move focus onto
  // its Undo button so the 6s window is reachable without a blind tab from
  // <body> (ChatPanel having just unmounted). The persistent live region still
  // announces the text; this only places focus. Non-action notices don't grab
  // focus. When the notice clears, return focus to main if we placed it there.
  //
  // Keyed on the action notice's NONCE, not merely "has an action": if a second
  // action toast supersedes a first within the window, hasAction would stay true
  // and the effect would NOT re-run, leaving focus stranded on the prior (now
  // removed) Undo button. The nonce changes per notice, so each new action toast
  // re-runs the focus move onto ITS button. `null` while there's no action.
  const actionNonce = notice?.action ? notice.nonce : null;
  useEffect(() => {
    if (actionNonce !== null) {
      movedFocusForNotice.current = true;
      // rAF so the button is laid out before we focus it.
      const id = requestAnimationFrame(() => undoRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    // The action notice went away (timeout/replacement) without going through
    // dismissNotice — return focus to main if it was ours to return.
    returnFocusToMain();
  }, [actionNonce]);

  return {
    notice,
    terminalNotice,
    showNotice,
    dismissNotice,
    showTerminalNotice,
    undoRef,
    mainRef,
  };
}
