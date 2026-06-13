"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SasPhrase } from "@/lib/sas";
import {
  CheckIcon,
  PhraseTokens,
  SAS_MISMATCH_WARNING,
  SAS_UNAVAILABLE_MESSAGE,
  SAS_WHY_COMPARE,
  ShieldIcon,
  ShieldOffIcon,
  WarningIcon,
  type SasStatus,
} from "./SafetyPhrase";

export default function VideoPanel({
  localStream,
  remoteStream,
  onEnd,
  sasPhrase,
  sasStatus,
  onConfirmMatch,
  onFlagMismatch,
}: {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onEnd: () => void;
  sasPhrase: SasPhrase | null;
  sasStatus: SasStatus;
  onConfirmMatch: () => void;
  onFlagMismatch: () => void;
}) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const [controlsUp, setControlsUp] = useState(true);
  const calmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (localRef.current && localRef.current.srcObject !== localStream) {
      localRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteRef.current && remoteRef.current.srcObject !== remoteStream) {
      remoteRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Controls auto-calm: surface them on any interaction, then recede after a
  // few idle seconds. Keep them up while the remote video hasn't arrived.
  const wake = useCallback(() => {
    setControlsUp(true);
    if (calmTimer.current) clearTimeout(calmTimer.current);
    if (remoteStream) {
      calmTimer.current = setTimeout(() => setControlsUp(false), 3500);
    }
  }, [remoteStream]);

  // Once the remote video is present, begin the idle countdown so the controls
  // recede on their own. setState happens only in the async timeout.
  useEffect(() => {
    if (!remoteStream) return;
    const t = setTimeout(() => setControlsUp(false), 3500);
    return () => clearTimeout(t);
  }, [remoteStream]);

  useEffect(
    () => () => {
      if (calmTimer.current) clearTimeout(calmTimer.current);
    },
    [],
  );

  const hasPhrase =
    (sasStatus === "unverified" ||
      sasStatus === "verified" ||
      sasStatus === "flagged") &&
    sasPhrase !== null;

  // A flagged mismatch carries real consequence and must NEVER calm away or be
  // reduced to an unexplained chip. It stays pinned and fully visible
  // regardless of the controls' calm state, and always shows the full warning
  // sentence (handled by the persistent panel below).
  const flagged = sasStatus === "flagged";

  // The "unverified" prompt is the primary verification action — reading the
  // phrase aloud takes longer than the 3.5s idle calm, so it must stay visible
  // and NOT recede with the controls, or the "They match"/"They don't match"
  // buttons would vanish mid-comparison. We therefore pin the top scrim (which
  // hosts the phrase panel) open while unverified. Pending/verified/unavailable
  // keep following the normal calm behaviour.
  const sasPinned = sasStatus === "unverified";

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-ink-950"
      onPointerMove={wake}
      onPointerDown={wake}
      onKeyDown={wake}
    >
      <div className="relative flex-1 overflow-hidden">
        {/* Remote (full screen) */}
        <video
          ref={remoteRef}
          autoPlay
          playsInline
          className="h-full w-full bg-ink-900 object-cover"
        />

        {/* Designed waiting state */}
        {!remoteStream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-ink-950">
            <div className="aurora-field opacity-40" />
            <div className="relative flex h-28 w-28 items-center justify-center">
              {[0, 1.4].map((d) => (
                <span
                  key={d}
                  className="absolute h-16 w-16 rounded-full border-2 border-signal/40"
                  style={{
                    animation: "beacon 3.2s var(--ease-calm) infinite",
                    animationDelay: `${d}s`,
                  }}
                />
              ))}
              <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-signal/15 text-signal">
                <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="3" y="6" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M15 10.5l5-2.8v8.6l-5-2.8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              </span>
            </div>
            <p className="relative font-mono text-xs uppercase tracking-[0.18em] text-haze-300">
              Waiting for stranger&rsquo;s video…
            </p>
          </div>
        )}

        {/* Top scrim — Live pill (left) + safety-phrase panel (right).
            Auto-calms with the controls, EXCEPT while sasStatus === "unverified"
            (sasPinned), when it stays open so the read-aloud phrase and its
            verify buttons remain reachable for as long as the comparison takes.
            NOTE: the flagged warning is rendered separately below so it is
            never hidden by the calm. */}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4 transition-all duration-500 ${
            controlsUp || sasPinned ? "opacity-100" : "-translate-y-2 opacity-0"
          }`}
        >
          <span className="glass-faint flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
            <span className="font-mono text-[11px] uppercase tracking-wider text-haze-100">
              Live
            </span>
          </span>

          {/* Safety-phrase panel — recedes with the scrim. Renders across every
              non-flagged state so the video surface always stays consistent
              with the chat header (M4: pending + unavailable are no longer
              invisible here). The flagged warning is handled by the persistent
              panel below and so is intentionally excluded here. */}
          {!flagged && (
            <section
              aria-label="Safety phrase verification"
              className="glass-faint pointer-events-auto max-w-[16rem] rounded-2xl px-3 py-2.5"
            >
              {sasStatus === "pending" && (
                <p className="flex items-center gap-2 text-xs text-haze-300">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-signal/70" />
                  </span>
                  Securing…
                </p>
              )}

              {sasStatus === "unavailable" && (
                <div className="flex items-start gap-2 text-xs leading-relaxed text-haze-300">
                  <ShieldOffIcon className="mt-0.5 h-4 w-4 shrink-0 text-haze-400" />
                  <p>{SAS_UNAVAILABLE_MESSAGE}</p>
                </div>
              )}

              {hasPhrase && sasPhrase && (
                <>
                  <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-haze-400">
                    <ShieldIcon className="h-3 w-3" />
                    Read this aloud
                  </p>
                  <PhraseTokens phrase={sasPhrase} />

                  {sasStatus === "unverified" && (
                    <div className="mt-2">
                      <p className="mb-2 text-[11px] leading-relaxed text-haze-300">
                        {SAS_WHY_COMPARE}
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
                          className="flex h-8 items-center rounded-full px-2.5 text-xs font-medium text-haze-300 underline-offset-2 transition hover:text-danger-400 hover:underline active:scale-95"
                        >
                          They don’t match
                        </button>
                      </div>
                    </div>
                  )}

                  {sasStatus === "verified" && (
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-signal-300">
                      <CheckIcon className="h-4 w-4" />
                      Verified end-to-end
                    </p>
                  )}
                </>
              )}
            </section>
          )}
        </div>

        {/* Persistent quiet indicators for terminal NON-flagged states. These
            stay visible after the controls auto-calm so the verification result
            is never lost — but they are quiet (a recessive chip), because they
            are reassuring/neutral. Hidden while controls are up to avoid
            doubling with the full panel above. */}
        {!controlsUp && (sasStatus === "verified" || sasStatus === "unavailable") && (
          <div className="pointer-events-none absolute left-4 top-16 z-10 transition-opacity duration-500">
            {sasStatus === "verified" ? (
              <span className="glass-faint flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-signal-300">
                <CheckIcon className="h-3.5 w-3.5" />
                Verified
              </span>
            ) : (
              <span className="glass-faint flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-haze-300">
                <ShieldOffIcon className="h-3.5 w-3.5" />
                Not verified
              </span>
            )}
          </div>
        )}

        {/* Flagged mismatch — the heaviest state on this surface. It does NOT
            calm or recede, and it carries the FULL warning sentence (never a
            bare chip). Pinned top-centre, danger-weighted, always visible. */}
        {flagged && (
          <section
            aria-label="Safety phrase verification"
            className="animate-pill-in pointer-events-none absolute inset-x-0 top-16 z-20 flex justify-center px-4"
          >
            <div className="flex max-w-sm items-start gap-2.5 rounded-2xl border border-danger/60 bg-danger/20 px-4 py-3 text-danger-400 shadow-float backdrop-blur-md">
              <WarningIcon className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="text-sm font-semibold leading-tight">Not verified</p>
                <p className="mt-1 text-xs font-medium leading-relaxed">
                  {SAS_MISMATCH_WARNING}
                </p>
              </div>
            </div>
          </section>
        )}

        {/* Local (floating picture-in-picture) — settles in, then rests */}
        <div className="animate-scale-in absolute bottom-28 right-4 sm:bottom-24">
          <video
            ref={localRef}
            autoPlay
            playsInline
            muted
            className="h-44 w-32 rounded-2xl border border-haze-200/15 bg-ink-800 object-cover shadow-float"
          />
          <span className="absolute bottom-2 left-2 rounded-full bg-ink-950/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-haze-100 backdrop-blur">
            You
          </span>
        </div>
      </div>

      {/* Control bar — auto-calms, reappears on interaction or focus */}
      <div
        className={`absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-ink-950 to-transparent p-6 transition-all duration-500 focus-within:pointer-events-auto focus-within:translate-y-0 focus-within:opacity-100 ${
          controlsUp
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0"
        }`}
      >
        <button
          onClick={onEnd}
          className="flex items-center gap-2.5 rounded-full bg-danger px-7 py-3.5 font-semibold text-white shadow-float transition duration-300 ease-[var(--ease-spring)] hover:scale-[1.03] hover:bg-danger-400 active:scale-95"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 11c4.5-3 9.5-3 14 0v3l-3.5.6-.5-2.4c-2-.8-4-.8-6 0l-.5 2.4L5 14z"
              fill="currentColor"
            />
          </svg>
          End video
        </button>
      </div>

      {/* Screen-reader announcement of terminal verification states. Polite for
          verified and unavailable; assertive for flagged so a mismatch
          interrupts. */}
      <p className="sr-only" role="status" aria-live="polite">
        {sasStatus === "verified"
          ? "Safety phrase verified end-to-end."
          : sasStatus === "unavailable"
            ? SAS_UNAVAILABLE_MESSAGE
            : ""}
      </p>
      <p className="sr-only" role="alert" aria-live="assertive">
        {sasStatus === "flagged"
          ? `Safety phrase not verified. ${SAS_MISMATCH_WARNING}`
          : ""}
      </p>
    </div>
  );
}
