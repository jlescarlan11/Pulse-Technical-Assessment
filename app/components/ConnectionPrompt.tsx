"use client";

import { useEffect, useRef } from "react";
import { peerColor } from "@/lib/peerColor";

// Reusable centered prompt for "someone wants to connect" and
// "someone wants to start video".
export default function ConnectionPrompt({
  title,
  subtitle,
  acceptLabel,
  declineLabel,
  onAccept,
  onDecline,
  peerId,
  variant = "connect",
}: {
  title: string;
  subtitle?: string;
  acceptLabel: string;
  declineLabel: string;
  onAccept: () => void;
  onDecline: () => void;
  peerId?: string;
  variant?: "connect" | "video";
}) {
  const acceptRef = useRef<HTMLButtonElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);

  // Focus management: move focus into the dialog, trap Tab between the two
  // actions, and let Escape decline.
  useEffect(() => {
    acceptRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onDecline();
      } else if (e.key === "Tab") {
        e.preventDefault();
        const next =
          document.activeElement === acceptRef.current
            ? declineRef.current
            : acceptRef.current;
        next?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDecline]);

  const accent =
    peerId !== undefined ? peerColor(peerId) : "var(--color-signal)";

  return (
    <div
      className="animate-fade-in absolute inset-0 z-40 flex items-center justify-center bg-ink-950/70 p-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onDecline}
    >
      <div
        className="animate-scale-in glass w-full max-w-sm rounded-2xl p-7 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Identity orb — an incoming signal in the peer's colour.
            The halo radiates from the orb but stays within the card. */}
        <div className="relative mx-auto mb-7 flex h-14 w-14 items-center justify-center">
          <span
            className="absolute h-14 w-14 rounded-full"
            style={{
              animation: "halo 2.8s var(--ease-calm) infinite",
              border: `1.5px solid ${accent}`,
            }}
          />
          <span
            className="absolute h-14 w-14 rounded-full"
            style={{
              animation: "halo 2.8s var(--ease-calm) infinite",
              animationDelay: "1.4s",
              border: `1.5px solid ${accent}`,
            }}
          />
          <span
            className="relative flex h-14 w-14 items-center justify-center rounded-full text-ink-950"
            style={{
              background: `radial-gradient(circle at 35% 30%, #fff, ${accent} 75%)`,
              boxShadow: `0 0 22px -6px ${accent}`,
            }}
          >
            {variant === "video" ? <VideoIcon /> : <SignalIcon />}
          </span>
        </div>

        <h2 className="text-xl font-semibold tracking-tight text-haze-50">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1.5 text-sm leading-relaxed text-haze-300">
            {subtitle}
          </p>
        )}

        <div className="mt-7 flex gap-3">
          <button
            ref={declineRef}
            onClick={onDecline}
            className="flex-1 rounded-full border border-haze-200/15 bg-ink-800/50 px-4 py-3 text-sm font-medium text-haze-200 transition hover:border-haze-200/30 hover:text-haze-50 active:scale-95"
          >
            {declineLabel}
          </button>
          <button
            ref={acceptRef}
            onClick={onAccept}
            className="flex-1 rounded-full bg-signal px-4 py-3 text-sm font-semibold text-ink-950 shadow-glow transition duration-300 ease-[var(--ease-spring)] hover:scale-[1.03] hover:shadow-glow-lg active:scale-95"
          >
            {acceptLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function SignalIcon() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12a7 7 0 0 1 7-7M5 12a7 7 0 0 0 7 7M19 12a7 7 0 0 0-7-7M19 12a7 7 0 0 1-7 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.55"
      />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="6"
        width="12"
        height="12"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M15 10.5l5-2.8v8.6l-5-2.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}
