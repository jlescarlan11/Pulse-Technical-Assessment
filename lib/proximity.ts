// Phase 4 "Proximity Pulse" (warmer/colder) — the PURE, framework-free core of
// an ambient signal that intensifies as the single nearest anonymous peer trends
// CLOSER over a session. "Turn location into a feeling, not data."
//
// HONESTY INVARIANT (stakeholder, locked): this module turns coordinates into a
// TREND, never a measurement. Nothing here is rendered verbatim — the component
// maps `trend`/`level` to calm copy + a glow. We deliberately expose only a
// coarse, smoothed `level` and a `trend` word; the raw `smoothedDistance` (km)
// is internal carry state for the reducer and MUST NOT be shown to the user (no
// number, no bearing, no identity, no per-dot link).
//
// Style mirrors lib/blocklist.ts and lib/chatRate.ts: pure functions + a couple
// of named tunables, no React, deterministic so the trend logic is trivially
// unit-testable (the test-engineer owns the tests).

import type { PeerDot } from "@/lib/types";

// --- Tunable constants (single source of truth) ----------------------------

/**
 * Exponential-moving-average weight applied to each NEW nearest-distance sample.
 * smoothed = SMOOTHING_ALPHA * sample + (1 - SMOOTHING_ALPHA) * priorSmoothed.
 *
 * WHY smoothing at all: each peer's dot carries a fresh random 1–3 km privacy
 * offset (see lib/geo.ts applyPrivacyOffset), so the raw nearest-distance is
 * noisy even for a stationary peer. An EMA lets a single noisy sample nudge, but
 * not flip, the state.
 *
 * Default 0.35: responsive enough to feel a real approach within a few ~1.5s
 * polls, damped enough that one jittery sample can't swing the smoothed value
 * past the dead-band on its own. Lower = calmer/slower, higher = twitchier.
 */
export const SMOOTHING_ALPHA = 0.35;

/**
 * Hysteresis dead-band, in kilometres. The smoothed distance must move by MORE
 * than this between the prior smoothed value and the new one before we call it
 * "stronger" or "fainter"; anything inside the band reads "steady".
 *
 * WHY a dead-band (not bare comparison): without it, sub-noise wobble around a
 * stationary peer would forever flip stronger/fainter and the indicator would
 * never settle. The band is the "must move meaningfully to count" gate that
 * makes a STATIC peer produce a STEADY indicator (a locked spec requirement).
 *
 * Default 0.25 km: comfortably above per-poll EMA jitter from a 1–3 km offset,
 * well below a genuine approach. Tune here only.
 */
export const HYSTERESIS_BAND_KM = 0.25;

/**
 * Intensity ceiling, in kilometres. `level` (0..1) is how "present" the nearest
 * signal feels: it scales the glow. We map the smoothed distance onto [0,1] with
 * 0 km → 1 (very present) and INTENSITY_RANGE_KM or beyond → 0 (faint/far).
 *
 * This is an AMBIENT presence cue, NOT a readout — it is intentionally coarse and
 * never surfaced as a value. Default 12 km: within ~a dozen km the glow has
 * begun to warm; far beyond that it rests near its dim floor.
 */
export const INTENSITY_RANGE_KM = 12;

/** Earth mean radius in km, for the haversine great-circle distance below. */
const EARTH_RADIUS_KM = 6371;

// --- Distance --------------------------------------------------------------

/**
 * Great-circle (haversine) distance between two lat/lng points, in kilometres.
 *
 * NOTE: this is a PROPER spherical distance — it is NOT the flat
 * KM_PER_DEG_LAT approximation used by the privacy OFFSET in lib/geo.ts (that
 * one only needs to nudge a point a couple of km and never measures between two
 * arbitrary points). We need the real thing because the nearest peer can be far
 * away and across longitudes.
 */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// --- Nearest peer ----------------------------------------------------------

/** The single nearest non-busy peer and its distance, or null if none. */
export interface NearestPeer {
  id: string;
  distanceKm: number;
}

/**
 * Find the single nearest NON-BUSY peer to `me`. Busy peers are excluded because
 * they can't be connected to, so they shouldn't drive a "someone's getting
 * closer" feeling. Returns null when there is no fix or no eligible peer (the
 * defined ZERO/ABSENT state for the indicator).
 *
 * Pure: reads only its arguments, never mutates them.
 */
export function nearestPeer(
  peers: readonly PeerDot[],
  me: { lat: number; lng: number } | null,
): NearestPeer | null {
  if (!me) return null;
  let best: NearestPeer | null = null;
  for (const peer of peers) {
    if (peer.busy) continue;
    const distanceKm = haversineKm(me, peer);
    if (best === null || distanceKm < best.distanceKm) {
      best = { id: peer.id, distanceKm };
    }
  }
  return best;
}

// --- Trend reducer ---------------------------------------------------------

/** The coarse direction the nearest signal is trending. */
export type Trend = "stronger" | "fainter" | "steady" | "neutral";

/**
 * The smoothed trend state. Carried across samples by the component; produced
 * only by `reduceTrend`. `smoothedDistance` is INTERNAL (never rendered).
 */
export interface TrendState {
  /** Identity of the nearest peer this state is tracking (null when absent). */
  trendId: string | null;
  /** EMA of that peer's distance, km. Internal carry — never shown. */
  smoothedDistance: number;
  /** Ambient presence 0..1 (0 far/faint → 1 near/present). Drives the glow. */
  level: number;
  /** Coarse direction word. The component maps this to honest copy. */
  trend: Trend;
}

/** The defined ZERO/ABSENT (and initial) state: nothing to feel. */
export const NEUTRAL_STATE: TrendState = {
  trendId: null,
  smoothedDistance: 0,
  level: 0,
  trend: "neutral",
};

/** Map a smoothed distance (km) to the ambient 0..1 presence level. */
function levelFor(distanceKm: number): number {
  const t = 1 - distanceKm / INTENSITY_RANGE_KM;
  return Math.max(0, Math.min(1, t));
}

/**
 * The trend reducer: given the PRIOR smoothed state and a NEW nearest sample,
 * return the next state. Pure and deterministic (no time, no randomness) so the
 * test-engineer can drive it with fixed sample sequences.
 *
 * Three behaviours encode the locked spec:
 *
 *  1. ABSENT — `next` is null (no fix / no non-busy peer): return NEUTRAL. The
 *     component debounces announcements so this can't spam the live region.
 *
 *  2. NEAREST-SWAP RESET — the incoming nearest id differs from the one we were
 *     tracking (a closer peer appeared, or the prior nearest went busy/offline).
 *     We CANNOT compare two different peers' distances without inventing a
 *     phantom jump, so we RESET: seed the EMA fresh at this peer's distance and
 *     report `neutral` (NOT stronger/fainter). The component must emit no trend
 *     announcement on a swap — `trend: "neutral"` is the signal for that.
 *
 *  3. SAME PEER — compare the new EMA to the PRIOR smoothed distance through the
 *     hysteresis dead-band: a decrease beyond the band is "stronger", an increase
 *     beyond it is "fainter", anything within the band is "steady". Because a
 *     static peer's smoothed distance barely moves, it lands in the band ⇒
 *     "steady", never a phantom climb.
 */
export function reduceTrend(
  prior: TrendState,
  next: NearestPeer | null,
): TrendState {
  // (1) Absent → defined neutral state.
  if (next === null) {
    return NEUTRAL_STATE;
  }

  // (2) Nearest-peer identity changed (or we had none) → reset, seed fresh.
  // Reporting a trend here would compare two unrelated peers' distances and
  // fabricate a "getting stronger/fainter" jump — explicitly forbidden.
  if (prior.trendId !== next.id) {
    return {
      trendId: next.id,
      smoothedDistance: next.distanceKm,
      level: levelFor(next.distanceKm),
      trend: "neutral",
    };
  }

  // (3) Same peer → advance the EMA and classify through the dead-band.
  const smoothed =
    SMOOTHING_ALPHA * next.distanceKm +
    (1 - SMOOTHING_ALPHA) * prior.smoothedDistance;
  const delta = smoothed - prior.smoothedDistance; // <0 closer, >0 farther

  let trend: Trend;
  if (delta < -HYSTERESIS_BAND_KM) {
    trend = "stronger"; // smoothed distance fell meaningfully → getting closer
  } else if (delta > HYSTERESIS_BAND_KM) {
    trend = "fainter"; // smoothed distance rose meaningfully → drifting away
  } else {
    trend = "steady"; // inside the dead-band → no meaningful change
  }

  return {
    trendId: next.id,
    smoothedDistance: smoothed,
    level: levelFor(smoothed),
    trend,
  };
}
