"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Map as MapboxMap, Marker } from "mapbox-gl";
import type { PeerDot } from "@/lib/types";
import { peerColor } from "@/lib/peerColor";

// Empty string (never a placeholder token) when unset, so no Mapbox secret is
// baked into the bundle and the graceful "set your token" fallback below renders
// instead of the map failing silently. (Phase 3 M1 + Phase 2 peerColor refactor.)
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

// Once the coach hint has been seen this session we don't nag on every render
// (route changes, peer churn, reconnects). Cleared when the tab closes.
const COACH_SEEN_KEY = "pulse.coachSeen";

// M2 — derive a STABLE 4-char code from a peer id. Index labels ("Signal N")
// renumber under churn; this is tied to the specific peer and stays put for the
// session. Deterministic FNV-1a hash → base36, padded/sliced to a 4-char code,
// rendered in the mono "code" voice. The same id always yields the same code,
// and it's the SR referent that pairs with the peerColor swatch.
function peerCode(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned, base36, last 4 chars, uppercase. Left-pad so it's always 4 wide.
  return (h >>> 0).toString(36).toUpperCase().padStart(4, "0").slice(-4);
}

export default function WorldMap({
  peers,
  me,
  onPeerClick,
  canConnect,
}: {
  peers: PeerDot[];
  me: { lat: number; lng: number } | null;
  onPeerClick: (id: string) => void;
  canConnect: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const meMarkerRef = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);

  // C2 — accessible fallback path: the count chip toggles a focusable list of
  // nearby signals so keyboard / screen-reader users can connect without
  // hunting spatial markers. The list is an honest DISCLOSURE (not a modal):
  // the chip is the toggle (aria-expanded + aria-controls), the list carries
  // `listId`, Escape + outside-click close it, and focus returns to the chip —
  // but focus is NOT trapped, because the map behind it stays interactive.
  const [listOpen, setListOpen] = useState(false);
  const listId = useId();
  const chipRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // M2(a) — first-entry coach hint. Default to hidden so SSR + first paint stay
  // stable, then resolve against sessionStorage on mount.
  const [coachVisible, setCoachVisible] = useState(false);

  const dismissCoach = useCallback(() => {
    setCoachVisible(false);
    try {
      sessionStorage.setItem(COACH_SEEN_KEY, "1");
    } catch {
      // Private-mode / storage-disabled: the hint just shows once per mount.
    }
  }, []);

  // Close the disclosure and RETURN FOCUS to the chip (the toggle). Called from
  // Escape, outside-click, and after a selection so keyboard users never lose
  // their place behind the (now-gone) list.
  const closeList = useCallback(() => {
    setListOpen(false);
    chipRef.current?.focus();
  }, []);

  // Connecting from any path (a dot, the list, a keyboard activation) retires
  // the coach hint and remembers that for the session.
  const connectTo = useCallback(
    (id: string) => {
      onPeerClick(id);
      dismissCoach();
      setListOpen(false);
    },
    [onPeerClick, dismissCoach],
  );

  // Marker click handlers are bound once, so read the live connect handler +
  // connectability through refs (synced in an effect, never during render).
  const connectRef = useRef(connectTo);
  const canConnectRef = useRef(canConnect);
  useEffect(() => {
    connectRef.current = connectTo;
    canConnectRef.current = canConnect;
  });

  // Resolve coach visibility once on mount and auto-fade after a few seconds.
  // The show is scheduled (not set synchronously in the effect body) to avoid a
  // cascading render, and to read sessionStorage only on the client.
  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(COACH_SEEN_KEY) === "1";
    } catch {
      seen = false;
    }
    if (seen) return;
    const show = setTimeout(() => setCoachVisible(true), 0);
    const fade = setTimeout(() => dismissCoach(), 6_000);
    return () => {
      clearTimeout(show);
      clearTimeout(fade);
    };
  }, [dismissCoach]);

  // C2 disclosure behaviour — only while open. Escape closes (and returns focus
  // via closeList); a pointerdown anywhere outside the chip+list also closes.
  // Not modal: no focus trap, the map stays reachable. Listeners are torn down
  // when the list closes or the component unmounts.
  useEffect(() => {
    if (!listOpen) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeList();
      }
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (
        listRef.current?.contains(target) ||
        chipRef.current?.contains(target)
      ) {
        return;
      }
      // Outside the chip+list — collapse, but don't yank focus back to the chip
      // (the user is clicking elsewhere on purpose); just close.
      setListOpen(false);
    }

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [listOpen, closeList]);

  // On open, move focus to the first row so keyboard users land inside the
  // disclosure (acceptable for an interactive menu-style list). Focus return to
  // the chip is handled by closeList on Escape / selection.
  useEffect(() => {
    if (!listOpen) return;
    const firstRow = listRef.current?.querySelector<HTMLButtonElement>(
      "button:not([disabled])",
    );
    firstRow?.focus();
  }, [listOpen]);

  // Initialise the map once.
  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;
    const markers = markersRef.current;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled || !containerRef.current) return;
      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/dark-v11",
        // Open centered on the user if we know where they are, else world view.
        center: me ? [me.lng, me.lat] : [0, 20],
        zoom: me ? 4 : 1.4,
        attributionControl: true,
      });
      map.on("load", () => {
        if (!cancelled) setReady(true);
      });
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      markers.forEach((m) => m.remove());
      markers.clear();
      meMarkerRef.current?.remove();
      meMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
    };
    // `me` is only read for the initial center; we don't want to re-init on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show / move the user's own "you are here" pin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !me) return;
    let cancelled = false;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      if (!meMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "pulse-me";
        el.title = "You are here";
        el.innerHTML = `<span class="pulse-me-label">You</span>`;
        // The glowing dot + ring are drawn in CSS, so anchor "center" seats
        // the marker exactly on the coordinate.
        meMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
          .setLngLat([me.lng, me.lat])
          .addTo(map);
      } else {
        meMarkerRef.current.setLngLat([me.lng, me.lat]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [me, ready]);

  // Reconcile markers whenever the peer list changes (or the map becomes ready).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;

    (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      const markers = markersRef.current;
      const seen = new Set<string>();

      for (const peer of peers) {
        seen.add(peer.id);
        let marker = markers.get(peer.id);
        if (!marker) {
          // The .pulse-dot button is now a >=44px invisible hit area (C1); the
          // visible ~15px signal is its inner .pulse-dot-core child (CSS owns
          // both — see globals.css). The button is natively keyboard-focusable
          // and fires connect on Enter/Space (C2), inheriting the global
          // :focus-visible ring.
          const el = document.createElement("button");
          el.type = "button";
          el.className = "pulse-dot";
          const core = document.createElement("span");
          core.className = "pulse-dot-core";
          // The core + sonar ring read this custom property (see globals.css).
          core.style.setProperty("--dot", peerColor(peer.id));
          el.appendChild(core);
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            // Read through refs so the bound-once handler never goes stale.
            if (canConnectRef.current) connectRef.current(peer.id);
          });
          marker = new mapboxgl.Marker({ element: el })
            .setLngLat([peer.lng, peer.lat])
            .addTo(map);
          markers.set(peer.id, marker);
        }
        // Busy peers — and everyone, while we're already in a connection — are
        // dimmed and non-interactive so the hover/cursor affordance matches
        // what a tap will actually do.
        const dot = marker.getElement() as HTMLButtonElement;
        const reachable = !peer.busy && canConnect;
        dot.style.opacity = peer.busy ? "0.4" : "1";
        dot.style.pointerEvents = reachable ? "auto" : "none";
        dot.disabled = !reachable;
        dot.title = peer.busy ? "In another conversation" : "Tap to connect";
        // Pair the stable code with the action so the dot's accessible name
        // matches the list row referent (M2).
        const code = peerCode(peer.id);
        dot.setAttribute(
          "aria-label",
          peer.busy
            ? `Signal ${code}, currently busy`
            : `Connect with signal ${code}`,
        );
      }

      // Drop markers for peers that went offline / got filtered out.
      for (const [id, marker] of markers) {
        if (!seen.has(id)) {
          marker.remove();
          markers.delete(id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [peers, ready, canConnect]);

  const hasPeers = peers.length > 0;
  const showLoading = Boolean(TOKEN) && !ready;

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full bg-ink-900" />

      {/* Soft top + bottom scrims so the glass HUD always reads over the map */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-ink-950/70 to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-ink-950/70 to-transparent"
      />

      {/* M1 — designed loading state over the ink field while Mapbox imports /
          initialises. A pulsing signal-mint beacon + mono label, reusing the
          radar vocabulary instead of a blank ink rectangle. The beacon ring
          (animate-ping) is dropped under reduced motion by globals.css, and the
          core holds at a non-zero resting opacity so it stays visible. */}
      {showLoading && (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-ink-950"
        >
          <span className="relative flex h-4 w-4 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-signal opacity-90 shadow-glow-sm" />
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-haze-300">
            Tuning in…
          </span>
        </div>
      )}

      {!TOKEN && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="glass max-w-md rounded-2xl p-5 text-sm text-haze-200">
            Set{" "}
            <code className="font-mono text-signal">NEXT_PUBLIC_MAPBOX_TOKEN</code>{" "}
            in <code className="font-mono text-haze-100">.env</code> to load the
            map.
          </p>
        </div>
      )}

      {/* Brand mark — top left */}
      <div className="glass-faint absolute left-4 top-4 flex items-center gap-2.5 rounded-full py-2 pl-3 pr-4">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-signal shadow-glow-sm" />
        </span>
        <span className="text-sm font-semibold tracking-tight text-haze-50">
          Pulse
        </span>
      </div>

      {/* M2(a) — first-entry coach hint, mono label voice. Auto-fades after a
          few seconds, on first connect, or when dismissed. MINOR 3 — only ever
          shown when there ARE peers, so it never contradicts the zero-state. */}
      {coachVisible && ready && hasPeers && (
        <div className="animate-fade-up pointer-events-none absolute left-1/2 top-20 -translate-x-1/2">
          <span className="glass-faint pointer-events-auto flex items-center gap-2 rounded-full px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-haze-200">
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-signal shadow-glow-sm"
            />
            Tap a signal to say hello
            {/* NIT 1 — the visible glyph stays small (h-2.5 w-2.5) but the
                button carries a >=44px hit area via padding + a negative margin
                so the chip's visual size is unchanged. */}
            <button
              type="button"
              onClick={dismissCoach}
              aria-label="Dismiss hint"
              className="-m-3 ml-0 grid h-11 w-11 place-items-center rounded-full text-haze-400 transition-colors hover:text-haze-100"
            >
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
                <path
                  d="M2 2l8 8M10 2l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </span>
        </div>
      )}

      {/* Live presence count — bottom left. The chip is itself the C2 accessible
          entry point: it toggles a focusable disclosure of nearby signals. */}
      <div className="absolute bottom-4 left-4 flex flex-col items-start gap-2">
        {/* M2(b) — calm zero-state reassurance when no one is around yet. */}
        {ready && !hasPeers && (
          <p className="glass-faint animate-fade-up max-w-[15rem] rounded-2xl px-4 py-2.5 text-xs leading-relaxed text-haze-300">
            No signals nearby yet — stay on, someone will appear.
          </p>
        )}

        {/* C2 — nearby-signals disclosure. A glass panel of buttons, each
            calling connect. Busy rows are disabled; respects canConnect. This
            is a non-modal DISCLOSURE controlled by the chip (aria-controls):
            no role="dialog", no focus trap — Escape + outside-click close it
            and return focus to the chip (MAJOR 1). */}
        {listOpen && hasPeers && (
          <div
            ref={listRef}
            id={listId}
            className="glass animate-scale-in w-64 max-w-[80vw] origin-bottom rounded-2xl p-2"
          >
            <p className="px-2 pb-1.5 pt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-haze-400">
              Nearby signals
            </p>
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {peers.map((peer) => {
                const reachable = !peer.busy && canConnect;
                // M2 — stable per-peer code (replaces volatile "Signal {i+1}")
                // and the SR referent for the colour swatch.
                const code = peerCode(peer.id);
                const status = peer.busy
                  ? "Busy"
                  : reachable
                    ? "Tap to connect"
                    : "Unavailable";
                return (
                  <li key={peer.id}>
                    <button
                      type="button"
                      disabled={!reachable}
                      onClick={() => reachable && connectTo(peer.id)}
                      aria-label={`Signal ${code} — ${status}`}
                      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors enabled:hover:bg-ink-700/60 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {/* M2 — the swatch is the peer's identity colour; give it
                          an accessible name so SR users have the stable code as
                          a referent, not just a (now removed) volatile number. */}
                      <span
                        className="h-3 w-3 shrink-0 rounded-full shadow-glow-sm"
                        style={{ background: peerColor(peer.id) }}
                      >
                        <span className="sr-only">Signal {code}</span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-xs tracking-wide text-haze-100">
                          {code}
                        </span>
                        <span className="block font-mono text-[10px] uppercase tracking-[0.16em] text-haze-400">
                          {status}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <button
          ref={chipRef}
          type="button"
          onClick={() => hasPeers && setListOpen((v) => !v)}
          disabled={!hasPeers}
          aria-expanded={listOpen && hasPeers}
          aria-controls={listOpen && hasPeers ? listId : undefined}
          aria-label={
            hasPeers
              ? `${peers.length} ${peers.length === 1 ? "signal" : "signals"} nearby — open list to connect`
              : "No signals nearby"
          }
          className="glass-faint flex items-center gap-2.5 rounded-full px-4 py-2 transition-colors enabled:hover:bg-ink-700/50 disabled:cursor-default"
        >
          <svg className="h-3.5 w-3.5 text-signal" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M1 8h3l1.5-4 3 8L12 6l1-2h1"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-xs text-haze-200">
            <span className="font-mono font-semibold tabular-nums text-haze-50">
              {peers.length}
            </span>{" "}
            {peers.length === 1 ? "signal" : "signals"} nearby
          </span>
        </button>
      </div>
    </div>
  );
}
