"use client";

// Reusable centered prompt for "someone wants to connect" and
// "someone wants to start video".
export default function ConnectionPrompt({
  title,
  subtitle,
  acceptLabel,
  declineLabel,
  onAccept,
  onDecline,
}: {
  title: string;
  subtitle?: string;
  acceptLabel: string;
  declineLabel: string;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6 modal-backdrop">
      <div className="w-full max-w-xs rounded-2xl bg-zinc-900 p-6 text-center text-zinc-100 shadow-xl modal-content">
        <h2 className="text-xl font-semibold leading-tight sm:text-2xl">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
            {subtitle}
          </p>
        )}
        <div className="mt-6 flex gap-3 sm:gap-4">
          <button
            onClick={onDecline}
            className="flex-1 rounded-full border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-all duration-200 hover:border-zinc-500 hover:bg-zinc-800/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-600 active:scale-95 min-h-11"
          >
            {declineLabel}
          </button>
          <button
            onClick={onAccept}
            className="flex-1 rounded-full bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-all duration-200 hover:bg-emerald-300 hover:shadow-lg hover:shadow-emerald-500/30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-600 active:scale-95 min-h-11"
          >
            {acceptLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
