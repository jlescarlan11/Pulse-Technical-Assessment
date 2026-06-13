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

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-6 bg-zinc-950 px-4 py-6 text-zinc-100 sm:gap-8 sm:p-6 md:gap-8 animate-fade-in">
      <div className="text-center animate-fade-in-up">
        <h1 className="text-5xl font-bold tracking-tight sm:text-6xl md:text-7xl mb-3">
          Pulse
        </h1>
        <p className="mx-auto max-w-sm text-sm text-zinc-400 sm:text-base leading-relaxed">
          A living globe of anonymous strangers. Drop onto the map and connect.
        </p>
      </div>

      <button
        onClick={enter}
        disabled={status === "locating"}
        className="group relative inline-flex min-h-11 min-w-max items-center justify-center rounded-full bg-emerald-400 px-8 py-3 font-semibold text-zinc-950 transition-all duration-200 hover:bg-emerald-300 hover:shadow-lg hover:shadow-emerald-500/30 disabled:opacity-60 disabled:cursor-not-allowed active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 sm:min-h-12"
      >
        <span className="flex items-center gap-2">
          {status === "locating" && (
            <span className="spinner spinner-small"></span>
          )}
          {status === "locating" ? "Locating…" : "Enter Pulse"}
        </span>
      </button>

      {status === "error" && (
        <div className="mx-auto max-w-sm rounded-lg bg-red-950/40 border border-red-900/50 p-4 text-center text-sm text-red-300 animate-fade-in-up">
          {error}
        </div>
      )}

      <p className="mx-auto max-w-sm text-center text-xs text-zinc-500 leading-relaxed">
        No sign-up. Your dot is placed 1–3&nbsp;km from your real location.
        Nothing is stored — closing the tab ends everything.
      </p>
    </div>
  );
}
