"use client";

import { useState } from "react";

export default function EntryGate({
  onReady,
}: {
  onReady: (lat: number, lng: number) => void;
}) {
  const [status, setStatus] = useState<"idle" | "locating" | "error">("idle");
  const [error, setError] = useState<string>("");

  function enter() {
    if (!("geolocation" in navigator)) {
      setStatus("error");
      setError("Your browser doesn't support location access.");
      return;
    }
    setStatus("locating");
    setError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => onReady(pos.coords.latitude, pos.coords.longitude),
      (err) => {
        setStatus("error");
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission is required to place you on the map."
            : "Couldn't get your location. Please try again.",
        );
      },
      // High accuracy + maximumAge:0 forces a fresh fix (Wi-Fi/GPS scan)
      // instead of reusing the browser's cached IP-based location.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  const locating = status === "locating";

  return (
    <div className="relative flex min-h-full flex-1 flex-col items-center justify-center overflow-hidden bg-ink-950 px-6">
      {/* ---- Living atmosphere ---- */}
      <div className="aurora-field" />
      <div className="signal-grain" />

      {/* ---- Radar beacon: concentric rings + expanding pings ---- */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      >
        {/* static hairline rings */}
        {[260, 440, 640, 880].map((d) => (
          <span
            key={d}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border"
            style={{
              width: d,
              height: d,
              borderColor:
                "color-mix(in oklch, var(--color-signal) 12%, transparent)",
            }}
          />
        ))}
        {/* expanding signal pings */}
        {[0, 1.6, 3.2].map((delay) => (
          <span
            key={delay}
            className="absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-signal/40"
            style={{
              animation: "beacon 4.8s var(--ease-calm) infinite",
              animationDelay: `${delay}s`,
            }}
          />
        ))}
      </div>

      <div className="vignette" />

      {/* ---- Content ---- */}
      <div className="animate-fade-up relative z-10 flex w-full max-w-md flex-col items-center text-center">
        {/* Eyebrow */}
        <span className="mb-7 inline-flex items-center gap-2 rounded-full border border-haze-200/10 bg-ink-850/60 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-haze-300 backdrop-blur">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-signal" />
          </span>
          Live · anonymous · peer-to-peer
        </span>

        {/* Wordmark */}
        <h1 className="text-glow text-7xl font-semibold tracking-tight text-haze-50 sm:text-8xl">
          Pulse
        </h1>

        <p className="mt-5 max-w-xs text-balance text-base leading-relaxed text-haze-300">
          A living globe of strangers, broadcasting from the dark. Find a
          signal. Say hello.
        </p>

        {/* CTA */}
        <button
          onClick={enter}
          disabled={locating}
          className="group relative mt-10 inline-flex items-center gap-3 overflow-hidden rounded-full bg-signal px-9 py-4 text-base font-semibold text-ink-950 shadow-glow transition duration-300 ease-[var(--ease-spring)] hover:scale-[1.03] hover:shadow-glow-lg active:scale-95 disabled:cursor-default disabled:hover:scale-100"
        >
          {/* shimmer sweep */}
          <span
            aria-hidden
            className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/40 to-transparent transition-transform duration-700 group-hover:translate-x-full"
          />
          {locating ? (
            <>
              <Radar />
              <span className="relative">Finding your signal…</span>
            </>
          ) : (
            <>
              <span className="relative">Enter Pulse</span>
              <svg
                className="relative h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden
              >
                <path
                  d="M2 8h11M9 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </>
          )}
        </button>

        {/* Error */}
        {status === "error" && (
          <div className="animate-fade-up mt-6 flex max-w-sm items-start gap-2.5 rounded-2xl border border-danger/25 bg-danger/10 px-4 py-3 text-left text-sm text-danger-400">
            <svg
              className="mt-0.5 h-4 w-4 shrink-0"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
            >
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 5v3.5M8 11h.01"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Privacy footnote */}
        <p className="mt-10 max-w-xs font-mono text-[11px] leading-relaxed tracking-wide text-haze-500">
          No sign-up. Your dot lands 1–3&nbsp;km from your real location.
          Nothing is stored — closing the tab ends everything.
        </p>
      </div>
    </div>
  );
}

/* Small radar sweep used inside the CTA while locating */
function Radar() {
  return (
    <span className="relative inline-flex h-4 w-4 items-center justify-center">
      <span className="absolute h-4 w-4 rounded-full border border-ink-950/40" />
      <span
        className="absolute h-4 w-4 rounded-full border-2 border-transparent border-t-ink-950"
        style={{ animation: "spin 0.9s linear infinite" }}
      />
    </span>
  );
}
