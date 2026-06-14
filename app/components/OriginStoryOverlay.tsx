"use client";

import { useEffect, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Map as MapboxMap } from "mapbox-gl";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

// Me dot is always signal-green; peer dot uses the peerColor prop.
const ME_COLOR = "#4ade80";

// If the map doesn't fire "load" within this window (offline / expired token),
// dismiss the overlay automatically rather than blocking the chat permanently.
const LOAD_TIMEOUT_MS = 8000;

export default function OriginStoryOverlay({
  me,
  peer,
  peerColor,
  onDismiss,
}: {
  me: { lat: number; lng: number };
  peer: { lat: number; lng: number };
  peerColor: string;
  onDismiss: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);

  // `fading` drives the CSS opacity transition before onDismiss fires.
  // Transition duration is intentionally clamped to 0.001ms by the global
  // reduced-motion rule in globals.css — no separate motion-safe guard needed.
  const [fading, setFading] = useState(false);

  // Stable ref so timers and event handlers reach the latest onDismiss without
  // stale-closure issues.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  // Once dismissed (by click, timer, error, or Escape) we must never call
  // onDismiss a second time regardless of which path fires last.
  const dismissedRef = useRef(false);

  // The 3s auto-dismiss timer is armed inside map.on("load") and cancelled on
  // early dismiss or on the 8s load-timeout path.
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The 400ms fade timer started by triggerDismiss — stored so the effect
  // cleanup can cancel it if the component unmounts during the fade window.
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function triggerDismiss() {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    if (autoTimer.current) {
      clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
    setFading(true);
    // pointer-events-none (applied via fading class) stops second clicks landing
    // on content below during the 400ms fade window. Stored in a ref so the
    // effect cleanup can cancel it if the component unmounts before it fires.
    fadeTimer.current = setTimeout(() => {
      onDismissRef.current();
    }, 400);
  }

  // Focus the overlay on mount so Escape is reachable without the user needing
  // to click first. The overlay is aria-hidden (purely visual), but keyboard
  // users still need an escape hatch from the 3-second pause.
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  // Escape key dismisses early — consistent with every other interruptible
  // overlay in the app (ConnectionPrompt, Block toast).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") triggerDismiss();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Initialise a non-interactive Mapbox instance, add markers, then fitBounds.
  // Reduced-motion is checked by the caller (page.tsx) before mounting, so once
  // mounted we always run — the overlay itself has no JS camera animation.
  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    let cancelled = false;

    // 8s fallback: if the map never fires "load" (offline / expired token /
    // extreme latency), dismiss rather than leaving a permanent black void.
    const loadTimeout = setTimeout(() => {
      triggerDismiss();
    }, LOAD_TIMEOUT_MS);

    void (async () => {
      const mapboxgl = (await import("mapbox-gl")).default;
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = TOKEN;
      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/dark-v11",
        center: [me.lng, me.lat],
        zoom: 4,
        interactive: false,
        // true enables attribution (Mapbox TOS); the compact pill style comes
        // from the global .mapboxgl-ctrl-attrib CSS in globals.css.
        attributionControl: true,
      });

      mapRef.current = map;

      // Map error (bad token, network failure): dismiss immediately rather than
      // showing a broken black void that the user can't escape without clicking.
      map.on("error", () => {
        clearTimeout(loadTimeout);
        triggerDismiss();
      });

      map.on("load", () => {
        clearTimeout(loadTimeout);
        if (cancelled) return;

        // ── Me dot ──
        const meEl = document.createElement("div");
        meEl.style.cssText = [
          "width:12px",
          "height:12px",
          "border-radius:50%",
          `background:${ME_COLOR}`,
          `box-shadow:0 0 8px ${ME_COLOR}`,
          "pointer-events:none",
        ].join(";");
        new mapboxgl.Marker({ element: meEl, anchor: "center" })
          .setLngLat([me.lng, me.lat])
          .addTo(map);

        // ── Peer dot ──
        const peerEl = document.createElement("div");
        peerEl.style.cssText = [
          "width:12px",
          "height:12px",
          "border-radius:50%",
          `background:${peerColor}`,
          `box-shadow:0 0 8px ${peerColor}`,
          "pointer-events:none",
        ].join(";");
        new mapboxgl.Marker({ element: peerEl, anchor: "center" })
          .setLngLat([peer.lng, peer.lat])
          .addTo(map);

        // ── Camera ──
        // If both dots are at the same point fitBounds degenerates to a single
        // pixel; fall back to a sane fixed zoom.
        const samePoint = me.lat === peer.lat && me.lng === peer.lng;
        if (samePoint) {
          map.setCenter([me.lng, me.lat]);
          map.setZoom(13);
        } else {
          const bounds = new mapboxgl.LngLatBounds(
            [me.lng, me.lat],
            [peer.lng, peer.lat],
          );
          map.fitBounds(bounds, {
            padding: { top: 80, bottom: 80, left: 80, right: 80 },
            animate: false,
          });
        }

        // ── Auto-dismiss after 3 s ──
        autoTimer.current = setTimeout(() => {
          triggerDismiss();
        }, 3000);
      });
    })();

    return () => {
      cancelled = true;
      clearTimeout(loadTimeout);
      if (autoTimer.current) {
        clearTimeout(autoTimer.current);
        autoTimer.current = null;
      }
      if (fadeTimer.current) {
        clearTimeout(fadeTimer.current);
        fadeTimer.current = null;
      }
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // me/peer/peerColor frozen at mount — the overlay shows one connection's
    // origin and must not react to prop drift after mounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={overlayRef}
      // z-[60]: above z-50 toasts. tabIndex={-1}: receives focus on mount so
      // Escape is immediately reachable. pointer-events-none during fade so
      // second clicks don't land on content below.
      className={`absolute inset-0 z-[60] cursor-pointer bg-ink-950 transition-opacity duration-[400ms] pointer-events-auto${fading ? " pointer-events-none" : ""}`}
      style={{ opacity: fading ? 0 : 1 }}
      tabIndex={-1}
      onClick={triggerDismiss}
      role="presentation"
      aria-hidden="true"
    >
      {/* sr-only text gives keyboard/AT users context and an exit instruction
          even though the visual content (the map) is purely presentational. */}
      <span className="sr-only">
        Connection established — showing where you met on the map. Press Escape
        or click to continue to chat.
      </span>
      {/* bg-ink-950 on the outer div shows a dark base while tiles load so a
          slow connection looks deliberate rather than broken. */}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
