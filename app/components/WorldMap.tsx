"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Map as MapboxMap, Marker } from "mapbox-gl";
import type { PeerDot } from "@/lib/types";
import { peerColor } from "@/lib/peerColor";
import { callSign } from "@/lib/callsign";

// Empty string (never a placeholder token) when unset, so no Mapbox secret is
// baked into the bundle and the graceful "set your token" fallback below renders
// instead of the map failing silently. (Phase 3 M1 + Phase 2 peerColor refactor.)
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

// Once the coach hint has been seen this session we don't nag on every render
// (route changes, peer churn, reconnects). Cleared when the tab closes.
const COACH_SEEN_KEY = "pulse.coachSeen";

// Phase 4 (map controls) — the zoom we settle on when centering on the user.
// Shared by the initial center-on-me (map init) and the Recenter control so the
// two stay visually identical. ~4 = "your neighbourhood of the world".
const ME_ZOOM = 4;

// Phase 4 (map controls) — when framing peers, never tunnel past this zoom. The
// single-peer / coincident-points case has no spatial spread, so fitBounds would
// otherwise slam to max zoom and look broken (stakeholder tripwire). Capping at
// ME_ZOOM lands us at the same comfortable altitude as Recenter.
const FRAME_MAX_ZOOM = ME_ZOOM;

// Phase 4 (map controls) — read the live OS/browser reduced-motion preference at
// the moment of a camera move. Mapbox JS animates the camera in JS, NOT via CSS
// transitions, so the globals.css reduced-motion block does NOT govern it — we
// must branch on this and pass animate:false / use jumpTo ourselves. Read per
// move (not cached at mount) so toggling the OS setting mid-session is honoured.
// Guarded for the (never, here) SSR case where matchMedia is absent.
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
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

  // Phase 4 (map controls) — zoom-bound flags drive the at-limit state of the
  // +/- buttons. WHY aria-disabled (not the native `disabled` attr): a control
  // that disables itself WHILE it holds keyboard focus makes the browser
  // synchronously blur it to <body>, ejecting the keyboard user from the cluster
  // (BUG-5). aria-disabled keeps the button focusable and in the tab order — AT
  // still announces it as unavailable, the click handler no-ops at the bound, and
  // focus is never dropped. Synced from the map's "zoom" event (and on ready) —
  // never read from the map during render.
  const [atMinZoom, setAtMinZoom] = useState(false);
  const [atMaxZoom, setAtMaxZoom] = useState(false);

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

  // Phase 4 (map controls) — camera handlers. The buttons are re-rendered every
  // render, so these can close over live `me` / `peers` directly (no stale-ref
  // dance needed, unlike the bound-once marker click). Each delegates the zoom
  // *math* to Mapbox (which clamps to min/max internally and never throws at a
  // bound); only the chrome + the reduced-motion / framing policy is ours.
  const zoomIn = useCallback(() => {
    // aria-disabled buttons stay activatable (Enter/click) — no-op at the bound.
    if (atMaxZoom) return;
    mapRef.current?.zoomIn();
  }, [atMaxZoom]);

  const zoomOut = useCallback(() => {
    if (atMinZoom) return;
    mapRef.current?.zoomOut();
  }, [atMinZoom]);

  // Story 2 — Recenter on me. Fly back to the "You are here" pin at ME_ZOOM
  // (the same altitude the map opens at). Under reduced motion we jumpTo instead
  // of flyTo so a reduced-motion user doesn't get a swooping JS camera animation
  // the CSS reduced-motion block can't reach. Guarded on a live `me`.
  const recenterOnMe = useCallback(() => {
    const map = mapRef.current;
    if (!map || !me) return;
    const camera = { center: [me.lng, me.lat] as [number, number], zoom: ME_ZOOM };
    if (prefersReducedMotion()) {
      map.jumpTo(camera);
    } else {
      map.flyTo(camera);
    }
  }, [me]);

  // Story 3 — Frame all signals. Fit the camera to every PEER dot at once; the
  // user's own `me` pin is deliberately excluded so the frame answers "where are
  // the souls?", not "what's on my screen?" (Recenter already serves "take me to
  // me"). Two correctnesses ride along:
  //   • BUG-4 (antimeridian): unwrap each longitude to the SHORTEST arc relative
  //     to the first peer, so date-line-straddling peers (e.g. +179 and −179)
  //     frame tightly instead of zooming out around the whole globe the long
  //     way. Mapbox renders longitudes outside [-180,180] the short way.
  //   • Coincident/single-peer: clamp to FRAME_MAX_ZOOM so a no-spread point
  //     lands at a sane altitude instead of slamming to max zoom.
  // Reduced motion → animate:false (same JS-camera reasoning as Recenter).
  const frameAllSignals = useCallback(() => {
    const map = mapRef.current;
    if (!map || peers.length === 0) return;
    void (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      // The map may have been torn down during the dynamic import — bail if the
      // live ref no longer points at the map we captured.
      if (mapRef.current !== map) return;
      const ref = peers[0].lng;
      const bounds = new mapboxgl.LngLatBounds();
      for (const peer of peers) {
        // Unwrap to within 180° of the reference peer (BUG-4): if a peer is more
        // than half the globe away in raw lng, shift it by ±360 so the pair sits
        // on the short arc. Latitude passes through untouched.
        let lng = peer.lng;
        while (lng - ref > 180) lng -= 360;
        while (lng - ref < -180) lng += 360;
        bounds.extend([lng, peer.lat]);
      }
      map.fitBounds(bounds, {
        // Asymmetric padding so framed dots clear the top/bottom scrims and the
        // bottom-left presence chip instead of hiding under the HUD chrome
        // (QA BUG-6): more room at the bottom (presence chip + scrim) and left.
        padding: { top: 96, bottom: 112, left: 84, right: 64 },
        maxZoom: FRAME_MAX_ZOOM,
        animate: !prefersReducedMotion(),
      });
    })();
  }, [peers]);

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
        zoom: me ? ME_ZOOM : 1.4,
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

  // Phase 4 (map controls) — keep the +/- disabled flags in sync with where the
  // camera actually is. We compare against a small epsilon (not strict equality)
  // because Mapbox lands fractionally short of the exact min/max after a wheel /
  // pinch, and we still want the buttons to lock at the practical limit. Bound
  // once the map is ready, on the live "zoom" event, and torn down on unmount.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const sync = () => {
      const z = map.getZoom();
      const min = map.getMinZoom();
      const max = map.getMaxZoom();
      const eps = 0.01;
      setAtMinZoom(z <= min + eps);
      setAtMaxZoom(z >= max - eps);
    };

    sync();
    map.on("zoom", sync);
    return () => {
      map.off("zoom", sync);
    };
  }, [ready]);

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
        // Pair the stable call-sign with the action so the dot's accessible
        // name matches the list row referent (Phase 4 Story 1).
        const sign = callSign(peer.id);
        dot.setAttribute(
          "aria-label",
          peer.busy
            ? `${sign}, currently busy`
            : `Connect with ${sign}`,
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
  // Story 2 — Recenter is live the instant a fix lands; disabled (not hidden)
  // until then. Story 3 — Frame needs at least one peer to frame.
  const canRecenter = me !== null;
  const canFrame = hasPeers;

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

      {/* Phase 4 (map controls) — top-right cluster. Deliberately clears the
          brand mark (top-left), the coach hint (top-center, left-1/2), the
          presence chip (bottom-left) and Mapbox attribution (bottom-right). A
          vertical stack of glass buttons in the HUD vocabulary — NOT Mapbox's
          white NavigationControl chrome. Only mounts when TOKEN && ready, like
          the other map-dependent UI. Each button keeps a >=44px hit area (h-11
          w-11) with a small inner glyph, is a native <button> (keyboard +
          Enter/Space + the global :focus-visible ring), and surfaces its
          disabled state to assistive tech via the `disabled` attr. */}
      {TOKEN && ready && (
        <div
          role="group"
          aria-label="Map controls"
          className="glass-faint animate-fade-up absolute right-4 top-4 flex flex-col overflow-hidden rounded-xl"
        >
          {/* Story 1 — Zoom in. aria-disabled (not native disabled) at the max
              bound so focus is never yanked off it (BUG-5); the handler no-ops. */}
          <button
            type="button"
            onClick={zoomIn}
            aria-disabled={atMaxZoom}
            aria-label="Zoom in"
            className={`grid h-11 w-11 place-items-center transition-[transform,background-color,color] duration-150 ease-[var(--ease-spring)] ${
              atMaxZoom
                ? "cursor-not-allowed text-haze-600 opacity-50"
                : "text-haze-200 hover:bg-ink-700/50 hover:text-haze-50 active:scale-[0.96] active:bg-ink-700/70"
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden fill="none">
              <path
                d="M8 3v10M3 8h10"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* Hairline between the paired zoom controls. */}
          <span aria-hidden className="hairline mx-2 border-t" />

          {/* Story 1 — Zoom out. aria-disabled at the min-zoom bound. */}
          <button
            type="button"
            onClick={zoomOut}
            aria-disabled={atMinZoom}
            aria-label="Zoom out"
            className={`grid h-11 w-11 place-items-center transition-[transform,background-color,color] duration-150 ease-[var(--ease-spring)] ${
              atMinZoom
                ? "cursor-not-allowed text-haze-600 opacity-50"
                : "text-haze-200 hover:bg-ink-700/50 hover:text-haze-50 active:scale-[0.96] active:bg-ink-700/70"
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden fill="none">
              <path
                d="M3 8h10"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* Group separator — the nav actions are a distinct cluster from the
              zoom pair, so this divider sits with extra inset + breathing room
              (heavier than the intra-pair hairline above). */}
          <span aria-hidden className="hairline mx-2 my-1 border-t" />

          {/* Story 2 — Recenter on me. Disabled (not hidden) until a fix lands;
              the `me`-live closure enables it without a remount. */}
          <button
            type="button"
            onClick={recenterOnMe}
            aria-disabled={!canRecenter}
            aria-label="Recenter on me"
            className={`grid h-11 w-11 place-items-center transition-[transform,background-color,color] duration-150 ease-[var(--ease-spring)] ${
              canRecenter
                ? "text-haze-200 hover:bg-ink-700/50 hover:text-signal active:scale-[0.96] active:bg-ink-700/70"
                : "cursor-not-allowed text-haze-600 opacity-50"
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden fill="none">
              <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>

          {/* Hairline between the two nav actions. */}
          <span aria-hidden className="hairline mx-2 border-t" />

          {/* Story 3 — Frame all signals. Disabled when there are no peers to
              frame. Fits the camera over peers only (own pin excluded). */}
          <button
            type="button"
            onClick={frameAllSignals}
            aria-disabled={!canFrame}
            aria-label="Frame all signals"
            className={`grid h-11 w-11 place-items-center transition-[transform,background-color,color] duration-150 ease-[var(--ease-spring)] ${
              canFrame
                ? "text-haze-200 hover:bg-ink-700/50 hover:text-signal active:scale-[0.96] active:bg-ink-700/70"
                : "cursor-not-allowed text-haze-600 opacity-50"
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden fill="none">
              <path
                d="M2 5V3a1 1 0 0 1 1-1h2M11 2h2a1 1 0 0 1 1 1v2M14 11v2a1 1 0 0 1-1 1h-2M5 14H3a1 1 0 0 1-1-1v-2"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <circle cx="8" cy="8" r="1.4" fill="currentColor" />
            </svg>
          </button>
        </div>
      )}

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
                // Phase 4 Story 1 — stable per-peer call-sign (replaces the
                // 4-char code) and the SR referent for the colour swatch.
                const sign = callSign(peer.id);
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
                      aria-label={`${sign} — ${status}`}
                      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors enabled:hover:bg-ink-700/60 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {/* The swatch is the peer's identity colour; give it an
                          accessible name so SR users have the stable call-sign
                          as a referent, paired with the visible colour. */}
                      <span
                        className="h-3 w-3 shrink-0 rounded-full shadow-glow-sm"
                        style={{ background: peerColor(peer.id) }}
                      >
                        <span className="sr-only">{sign}</span>
                      </span>
                      <span className="min-w-0 flex-1">
                        {/* Full two-word handle; truncate gracefully if the row
                            is tight rather than redesigning the row. */}
                        <span className="block truncate text-xs font-medium tracking-normal text-haze-100">
                          {sign}
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
