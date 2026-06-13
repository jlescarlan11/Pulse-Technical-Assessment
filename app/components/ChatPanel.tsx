"use client";

import { useEffect, useRef, useState } from "react";

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
}: {
  messages: ChatMessage[];
  connected: boolean;
  videoBusy: boolean;
  onSend: (text: string) => void;
  onStartVideo: () => void;
  onEnd: () => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const [messageCount, setMessageCount] = useState(0);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    setMessageCount(messages.length);
  }, [messages]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !connected) return;
    onSend(text);
    setDraft("");
  }

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl chat-panel-enter md:max-w-sm lg:max-w-md">
      {/* Header */}
      <header className="flex flex-col gap-3 border-b border-zinc-800 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-semibold text-base sm:text-lg">Stranger</p>
          <p className="text-xs text-zinc-500 transition-colors duration-200">
            {connected ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
                Connected
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-small"></span>
                Connecting…
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onStartVideo}
            disabled={!connected || videoBusy}
            className="group relative inline-flex items-center justify-center rounded-full border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-all duration-200 hover:border-emerald-400 hover:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-600 active:scale-95 min-h-9"
          >
            Video
          </button>
          <button
            onClick={onEnd}
            className="group relative inline-flex items-center justify-center rounded-full bg-red-500 px-4 py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-red-400 hover:shadow-lg hover:shadow-red-500/30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-600 active:scale-95 min-h-9"
          >
            End
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="mt-8 text-center text-sm text-zinc-500 animate-fade-in">
            Say hello. Messages are peer-to-peer and never stored.
          </p>
        )}
        {messages.map((m, idx) => (
          <div
            key={m.id}
            className={`flex animate-fade-in-up ${m.mine ? "justify-end" : "justify-start"}`}
            style={{
              animationDelay: `${Math.min(idx * 0.05, 0.2)}s`,
            }}
          >
            <span
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm transition-all duration-200 ${
                m.mine
                  ? "bg-emerald-400 text-zinc-950 font-medium shadow-md shadow-emerald-500/20"
                  : "bg-zinc-800 text-zinc-100 shadow-sm shadow-zinc-950/50"
              }`}
            >
              {m.text}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={submit}
        className="flex gap-2 border-t border-zinc-800 bg-zinc-950 p-4 sm:p-3"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={connected ? "Type a message…" : "Connecting…"}
          disabled={!connected}
          className="flex-1 rounded-full bg-zinc-900 px-4 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 transition-all duration-200 hover:bg-zinc-800 focus:bg-zinc-800 focus:ring-2 focus:ring-emerald-400 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed min-h-10"
        />
        <button
          type="submit"
          disabled={!connected || !draft.trim()}
          className="group relative inline-flex items-center justify-center rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition-all duration-200 hover:bg-emerald-300 hover:shadow-lg hover:shadow-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-600 active:scale-95 min-h-10"
        >
          Send
        </button>
      </form>
    </div>
  );
}
