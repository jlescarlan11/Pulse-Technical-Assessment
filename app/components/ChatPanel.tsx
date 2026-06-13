"use client";

import { useEffect, useRef, useState } from "react";
import { peerColor } from "@/lib/peerColor";
import type { SasPhrase } from "@/lib/sas";
import {
  CheckIcon,
  PhraseTokens,
  SAS_COMPARE_PROMPT,
  SAS_MISMATCH_WARNING,
  SAS_UNAVAILABLE_MESSAGE,
  SAS_WHY_COMPARE,
  ShieldIcon,
  ShieldOffIcon,
  WarningIcon,
  type SasStatus,
} from "./SafetyPhrase";

export interface ChatMessage {
  id: number;
  mine: boolean;
  text: string;
}

export default function ChatPanel({
  messages,
  connected,
  videoBusy,
  onSend,
  onStartVideo,
  onEnd,
  peerId,
  sasPhrase,
  sasStatus,
  onConfirmMatch,
  onFlagMismatch,
}: {
  messages: ChatMessage[];
  connected: boolean;
  videoBusy: boolean;
  onSend: (text: string) => void;
  onStartVideo: () => void;
  onEnd: () => void;
  peerId?: string;
  sasPhrase: SasPhrase | null;
  sasStatus: SasStatus;
  onConfirmMatch: () => void;
  onFlagMismatch: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [slowConnect, setSlowConnect] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view by scrolling the list itself — never the
  // page — so the drawer can't shift the surrounding layout.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // If the channel hasn't opened after a few seconds, surface a gentle
  // "taking longer" hint so the connecting state is never a silent dead end.
  // Purely presentational — the connection lifecycle itself is unchanged.
  // (The status line still reads "Connected" once `connected` flips, so this
  // flag only ever shows while disconnected.)
  useEffect(() => {
    if (connected) return;
    const t = setTimeout(() => setSlowConnect(true), 8000);
    return () => clearTimeout(t);
  }, [connected]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !connected) return;
    onSend(text);
    setDraft("");
  }

  const accent =
    peerId !== undefined ? peerColor(peerId) : "var(--color-signal)";

  return (
    <div className="animate-slide-in glass absolute inset-y-0 right-0 z-30 flex w-full max-w-md flex-col border-0 border-l text-haze-50">
      {/* Header */}
      <header className="hairline flex items-center justify-between border-b px-4 py-3.5">
        <div className="flex items-center gap-3">
          {/* Identity orb in the peer's colour */}
          <span
            className="relative flex h-9 w-9 items-center justify-center rounded-full text-ink-950"
            style={{
              background: `radial-gradient(circle at 35% 30%, #fff, ${accent} 78%)`,
              boxShadow: `0 0 16px -3px ${accent}`,
            }}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="8" r="3.4" fill="currentColor" />
              <path
                d="M5.5 19a6.5 6.5 0 0 1 13 0"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div>
            <p className="font-semibold leading-tight tracking-tight">Stranger</p>
            <p className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-haze-400">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  connected ? "bg-signal shadow-glow-sm" : "animate-pulse bg-haze-400"
                }`}
              />
              {connected
                ? "Connected"
                : slowConnect
                  ? "Still connecting…"
                  : "Connecting…"}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onStartVideo}
            disabled={!connected || videoBusy}
            title="Start video"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-haze-200/15 text-haze-200 transition hover:border-signal/50 hover:text-signal active:scale-90 disabled:opacity-35 disabled:hover:border-haze-200/15 disabled:hover:text-haze-200"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="3" y="6" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="M15 10.5l5-2.8v8.6l-5-2.8" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={onEnd}
            title="End conversation"
            className="flex h-9 items-center gap-1.5 rounded-full bg-danger/15 px-3.5 text-sm font-medium text-danger-400 transition hover:bg-danger hover:text-white active:scale-95"
          >
            End
          </button>
        </div>
      </header>

      {/* Safety phrase — advisory end-to-end verification (Story 2 + 4) */}
      <SafetyPhraseRegion
        phrase={sasPhrase}
        status={sasStatus}
        onConfirmMatch={onConfirmMatch}
        onFlagMismatch={onFlagMismatch}
      />

      {/* Messages */}
      <div ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-5">
        {messages.length === 0 && (
          <div className="animate-fade-up mt-10 flex flex-col items-center gap-3 px-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-700/60 text-signal">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9l-4 4v-4H6.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <p className="text-sm font-medium text-haze-200">Say hello.</p>
            <p className="max-w-[15rem] text-xs leading-relaxed text-haze-500">
              Messages travel peer-to-peer and are never stored. When the tab
              closes, the conversation is gone.
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`animate-msg-in flex ${m.mine ? "justify-end" : "justify-start"}`}
          >
            <span
              className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                m.mine
                  ? "rounded-br-md bg-signal font-medium text-ink-950 shadow-glow-sm"
                  : "hairline rounded-bl-md border bg-ink-750/80 text-haze-100"
              }`}
            >
              {m.text}
            </span>
          </div>
        ))}
      </div>

      {/* Composer */}
      <form onSubmit={submit} className="hairline flex gap-2 border-t p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={connected ? "Send a signal…" : "Connecting…"}
          disabled={!connected}
          className="flex-1 rounded-full border border-haze-200/10 bg-ink-900/70 px-4 py-2.5 text-sm text-haze-50 outline-none transition placeholder:text-haze-500 focus:border-signal/40 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!connected || !draft.trim()}
          title="Send"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-signal text-ink-950 shadow-glow-sm transition duration-300 ease-[var(--ease-spring)] hover:scale-105 hover:shadow-glow active:scale-90 disabled:scale-100 disabled:opacity-35 disabled:shadow-none"
        >
          <svg className="h-4 w-4 rotate-45" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </form>
    </div>
  );
}

// The chat-header safety-phrase surface. Five states, each distinguished by
// ICON + TEXT (never colour alone). Verified/flagged/unavailable transitions
// are announced to assistive tech via aria-live regions so a screen-reader user
// hears the change without focus moving.
function SafetyPhraseRegion({
  phrase,
  status,
  onConfirmMatch,
  onFlagMismatch,
}: {
  phrase: SasPhrase | null;
  status: SasStatus;
  onConfirmMatch: () => void;
  onFlagMismatch: () => void;
}) {
  return (
    <section
      aria-label="Safety phrase verification"
      className="hairline border-b bg-ink-900/30 px-4 py-3"
    >
      <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-haze-500">
        <ShieldIcon className="h-3 w-3" />
        Safety phrase
      </p>

      {status === "unavailable" ? (
        // TERMINAL: derivation failed. Calm, non-positive — visually distinct
        // from the "pending" spinner (no live dot, a struck-through shield) and
        // never reads as a verified assurance.
        <div className="flex items-start gap-2 text-xs leading-relaxed text-haze-400">
          <ShieldOffIcon className="mt-0.5 h-4 w-4 shrink-0 text-haze-500" />
          <p>{SAS_UNAVAILABLE_MESSAGE}</p>
        </div>
      ) : status === "pending" || !phrase ? (
        <p className="flex items-center gap-2 text-xs text-haze-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-signal/70" />
          </span>
          Establishing secure phrase…
        </p>
      ) : (
        <>
          <PhraseTokens phrase={phrase} />

          {status === "unverified" && (
            <div className="mt-2.5">
              {/* The one plain-language "why" line, on first appearance of the
                  unverified state. */}
              <p className="mb-1 text-[11px] leading-relaxed text-haze-500">
                {SAS_WHY_COMPARE}
              </p>
              <p className="mb-2 text-xs leading-relaxed text-haze-400">
                {SAS_COMPARE_PROMPT}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onConfirmMatch}
                  className="flex h-8 items-center gap-1.5 rounded-full bg-signal/15 px-3 text-xs font-medium text-signal-300 transition hover:bg-signal hover:text-ink-950 active:scale-95"
                >
                  <ShieldIcon className="h-3.5 w-3.5" />
                  They match
                </button>
                <button
                  type="button"
                  onClick={onFlagMismatch}
                  className="flex h-8 items-center rounded-full px-3 text-xs font-medium text-haze-400 underline-offset-2 transition hover:text-danger-400 hover:underline active:scale-95"
                >
                  They don’t match
                </button>
              </div>
            </div>
          )}

          {status === "verified" && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-signal-300">
              <CheckIcon className="h-4 w-4" />
              Verified end-to-end
            </p>
          )}

          {status === "flagged" && (
            <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-danger-400">
              <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-xs font-medium leading-relaxed">
                Not verified. {SAS_MISMATCH_WARNING}
              </p>
            </div>
          )}
        </>
      )}

      {/* Screen-reader announcement of terminal states. Polite for verified and
          unavailable; assertive for flagged so a mismatch interrupts. Visually
          hidden. */}
      <p className="sr-only" role="status" aria-live="polite">
        {status === "verified"
          ? "Safety phrase verified end-to-end."
          : status === "unavailable"
            ? SAS_UNAVAILABLE_MESSAGE
            : ""}
      </p>
      <p className="sr-only" role="alert" aria-live="assertive">
        {status === "flagged" ? `Safety phrase not verified. ${SAS_MISMATCH_WARNING}` : ""}
      </p>
    </section>
  );
}
