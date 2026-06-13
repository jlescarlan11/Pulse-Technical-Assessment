"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export default function VideoPanel({
  localStream,
  remoteStream,
  onEnd,
}: {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onEnd: () => void;
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

        {/* Top scrim + Live indicator (auto-calms with controls) */}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-4 transition-all duration-500 ${
            controlsUp ? "opacity-100" : "-translate-y-2 opacity-0"
          }`}
        >
          <span className="glass-faint flex items-center gap-2 rounded-full px-3 py-1.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
            <span className="font-mono text-[11px] uppercase tracking-wider text-haze-100">
              Live
            </span>
          </span>
        </div>

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
    </div>
  );
}
