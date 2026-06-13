"use client";

import { useEffect, useRef } from "react";

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

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-black animate-fade-in">
      {/* Remote video (full screen) */}
      <div className="relative flex-1 overflow-hidden bg-black">
        <video
          ref={remoteRef}
          autoPlay
          playsInline
          className="h-full w-full object-cover"
        />
        {!remoteStream && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-transparent via-black/40 to-transparent">
            <div className="flex flex-col items-center gap-3">
              <div className="spinner spinner-large"></div>
              <p className="text-sm text-zinc-400">
                Waiting for stranger&rsquo;s video…
              </p>
            </div>
          </div>
        )}

        {/* Local video (picture-in-picture) */}
        {localStream && (
          <div className="absolute bottom-20 right-4 animate-fade-in">
            <video
              ref={localRef}
              autoPlay
              playsInline
              muted
              className="h-40 w-28 rounded-lg border-2 border-emerald-400/50 bg-zinc-800 object-cover shadow-lg shadow-black/50 transition-all duration-200 hover:border-emerald-400"
            />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col items-center gap-4 bg-gradient-to-t from-black via-black/80 to-transparent px-4 py-6 sm:py-8">
        <button
          onClick={onEnd}
          className="group relative inline-flex min-h-12 min-w-max items-center justify-center rounded-full bg-red-500 px-8 py-3 font-semibold text-white transition-all duration-200 hover:bg-red-400 hover:shadow-lg hover:shadow-red-500/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 active:scale-95"
        >
          End Video
        </button>
        <p className="text-xs text-zinc-500">
          P2P video • No recording
        </p>
      </div>
    </div>
  );
}
