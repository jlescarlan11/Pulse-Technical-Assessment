/**
 * Phase 4 "Proximity Pulse" — the PURE trend core.
 *
 * WHY THIS FILE: lib/proximity.ts is the deterministic, framework-free heart of
 * the ambient signal (mirrors lib/blocklist.ts / lib/chatRate.ts: pure
 * functions + a couple of tunables, no React). The honesty guarantees live
 * here — a STATIC peer must read "steady", a nearest-SWAP must NOT fabricate a
 * "stronger/fainter" jump — so they are unit-tested directly with fixed sample
 * sequences. No clock, no randomness, no DOM (node env, lib default).
 *
 * These tests assert BEHAVIOUR (distances, trend words, the level monotonicity),
 * never internals beyond the documented carry state the reducer is contracted
 * to maintain.
 */
import {
  haversineKm,
  nearestPeer,
  reduceTrend,
  NEUTRAL_STATE,
  HYSTERESIS_BAND_KM,
  INTENSITY_RANGE_KM,
  type NearestPeer,
  type TrendState,
} from "./proximity";
import type { PeerDot } from "@/lib/types";

// A PeerDot factory: id + position, not busy unless asked. Mirrors the dot()
// helper in lib/blocklist.test.ts.
function dot(
  id: string,
  lat: number,
  lng: number,
  busy = false,
): PeerDot {
  return { id, lat, lng, busy };
}

describe("haversineKm — great-circle distance", () => {
  it("is ~0 for two identical points", () => {
    const p = { lat: 40.7128, lng: -74.006 };
    expect(haversineKm(p, p)).toBeCloseTo(0, 6);
  });

  it("matches a known city-pair distance within tolerance (NYC ↔ London ≈ 5570 km)", () => {
    const nyc = { lat: 40.7128, lng: -74.006 };
    const london = { lat: 51.5074, lng: -0.1278 };
    // Published great-circle distance is ~5570 km; allow a generous ±30 km
    // tolerance for the spherical-Earth approximation.
    expect(haversineKm(nyc, london)).toBeCloseTo(5570, -2);
    expect(haversineKm(nyc, london)).toBeGreaterThan(5540);
    expect(haversineKm(nyc, london)).toBeLessThan(5600);
  });

  it("is symmetric: a→b equals b→a", () => {
    const a = { lat: 1.3521, lng: 103.8198 }; // Singapore
    const b = { lat: 35.6762, lng: 139.6503 }; // Tokyo
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });
});

describe("nearestPeer — single nearest NON-BUSY peer", () => {
  const me = { lat: 0, lng: 0 };

  it("returns null when me is null (no fix)", () => {
    expect(nearestPeer([dot("a", 0, 0)], null)).toBeNull();
  });

  it("returns null when there are no peers", () => {
    expect(nearestPeer([], me)).toBeNull();
  });

  it("returns null when ALL peers are busy", () => {
    const peers = [dot("a", 0, 1, true), dot("b", 0, 2, true)];
    expect(nearestPeer(peers, me)).toBeNull();
  });

  it("excludes busy peers even when a busy one is geometrically nearer", () => {
    // The busy peer sits right on top of me; the only eligible peer is farther.
    const peers = [dot("busy", 0, 0, true), dot("free", 0, 5, false)];
    const result = nearestPeer(peers, me);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("free");
  });

  it("returns the genuinely nearest among several free peers", () => {
    const peers = [
      dot("far", 0, 10),
      dot("near", 0, 1),
      dot("mid", 0, 5),
    ];
    const result = nearestPeer(peers, me);
    expect(result!.id).toBe("near");
    // And it carries that peer's real distance.
    expect(result!.distanceKm).toBeCloseTo(haversineKm(me, peers[1]), 9);
  });

  it("breaks ties deterministically toward the FIRST equally-near peer", () => {
    // Two peers at identical distance: strict `<` keeps the first seen, so the
    // result is stable across calls (no flapping on ties).
    const peers = [dot("first", 0, 3), dot("second", 0, 3)];
    expect(nearestPeer(peers, me)!.id).toBe("first");
    // Reversing input order flips which "first" wins — proving order, not id,
    // decides the tie (deterministic, not random).
    const reversed = [dot("second", 0, 3), dot("first", 0, 3)];
    expect(nearestPeer(reversed, me)!.id).toBe("second");
  });
});

describe("reduceTrend — ABSENT", () => {
  it("returns NEUTRAL_STATE when next is null", () => {
    const prior: TrendState = {
      trendId: "a",
      smoothedDistance: 4,
      level: 0.5,
      trend: "stronger",
    };
    expect(reduceTrend(prior, null)).toEqual(NEUTRAL_STATE);
    expect(reduceTrend(prior, null).trend).toBe("neutral");
  });
});

describe("reduceTrend — NEAREST-SWAP reset (no phantom trend)", () => {
  it("reports 'neutral' (NOT stronger/fainter) when the nearest peer id changes", () => {
    // Prior: tracking peer A, warmed up at 5 km.
    const prior: TrendState = {
      trendId: "A",
      smoothedDistance: 5,
      level: 0.5,
      trend: "stronger",
    };
    // A genuinely CLOSER peer B appears at 1 km. Naive distance comparison would
    // scream "stronger" — the reducer must instead RESET, never fabricate it.
    const next: NearestPeer = { id: "B", distanceKm: 1 };
    const result = reduceTrend(prior, next);

    expect(result.trend).toBe("neutral");
    expect(result.trendId).toBe("B");
    // The EMA is RE-SEEDED at B's distance, not carried from A.
    expect(result.smoothedDistance).toBe(1);
  });

  it("never emits stronger/fainter across the swap even when B is FARTHER than A's smoothed", () => {
    const prior: TrendState = {
      trendId: "A",
      smoothedDistance: 2,
      level: 0.8,
      trend: "steady",
    };
    const next: NearestPeer = { id: "B", distanceKm: 9 };
    const result = reduceTrend(prior, next);
    // Farther → a naive compare would say "fainter"; the swap forbids that.
    expect(result.trend).toBe("neutral");
    expect(result.trendId).toBe("B");
    expect(result.smoothedDistance).toBe(9);
  });
});

describe("reduceTrend — SAME peer over a sequence", () => {
  // Drive the reducer with a sequence of same-id samples, seeding from the
  // first sample (a swap into the peer) so the EMA starts settled.
  function runSequence(id: string, distances: number[]): TrendState[] {
    const states: TrendState[] = [];
    let state: TrendState = NEUTRAL_STATE;
    for (const d of distances) {
      state = reduceTrend(state, { id, distanceKm: d });
      states.push(state);
    }
    return states;
  }

  it("steadily DECREASING distance beyond the band → 'stronger'", () => {
    // First sample is a swap (neutral, seeds EMA); subsequent decreasing samples
    // should drive the smoothed distance down past the dead-band → "stronger".
    const states = runSequence("A", [10, 9, 8, 7, 6, 5, 4, 3]);
    const post = states.slice(1); // drop the seeding swap
    // At least the later samples (once the EMA has caught the steep descent)
    // read "stronger"; none read "fainter".
    expect(post.some((s) => s.trend === "stronger")).toBe(true);
    expect(post.every((s) => s.trend !== "fainter")).toBe(true);
    // The final, fully-warmed state is unambiguously stronger.
    expect(states[states.length - 1].trend).toBe("stronger");
  });

  it("steadily INCREASING distance beyond the band → 'fainter'", () => {
    const states = runSequence("A", [3, 4, 5, 6, 7, 8, 9, 10]);
    const post = states.slice(1);
    expect(post.some((s) => s.trend === "fainter")).toBe(true);
    expect(post.every((s) => s.trend !== "stronger")).toBe(true);
    expect(states[states.length - 1].trend).toBe("fainter");
  });

  it("STATIC distance (constant samples) → 'steady', NEVER stronger/fainter (the honesty guarantee)", () => {
    // A non-moving peer: identical samples. The EMA converges instantly and the
    // delta stays inside the dead-band forever → steady, never a phantom climb.
    const states = runSequence("A", [6, 6, 6, 6, 6, 6, 6, 6]);
    const post = states.slice(1); // after the seeding swap
    expect(post.every((s) => s.trend === "steady")).toBe(true);
    // Belt-and-braces: it must NEVER flip to either active trend.
    expect(post.some((s) => s.trend === "stronger" || s.trend === "fainter")).toBe(
      false,
    );
  });

  it("sub-band jitter (tiny ± noise around a constant) stays 'steady'", () => {
    // The privacy offset jitters each sample; a single noisy sample, damped by
    // the EMA, must stay inside the dead-band and NOT flip the state. Noise is
    // a fraction of HYSTERESIS_BAND_KM so even the raw deltas can't escape it.
    const j = HYSTERESIS_BAND_KM / 4; // well under the band
    const states = runSequence("A", [6, 6 + j, 6 - j, 6 + j, 6 - j, 6 + j, 6 - j]);
    const post = states.slice(1);
    expect(post.every((s) => s.trend === "steady")).toBe(true);
  });

  it("level is within [0,1] for every state and RISES as the smoothed distance falls", () => {
    const states = runSequence("A", [10, 9, 8, 7, 6, 5, 4, 3]);
    for (const s of states) {
      expect(s.level).toBeGreaterThanOrEqual(0);
      expect(s.level).toBeLessThanOrEqual(1);
    }
    // Approaching peer → smoothed distance falls monotonically → level rises
    // monotonically (non-strict; the EMA never overshoots a monotone input).
    const post = states.slice(1);
    for (let i = 1; i < post.length; i++) {
      expect(post[i].smoothedDistance).toBeLessThanOrEqual(post[i - 1].smoothedDistance);
      expect(post[i].level).toBeGreaterThanOrEqual(post[i - 1].level);
    }
  });

  it("level saturates: a peer at 0 km reads level 1; beyond INTENSITY_RANGE_KM reads level 0", () => {
    // Seed-then-hold at 0 km → fully present.
    const near = runSequence("A", [0, 0]);
    expect(near[near.length - 1].level).toBeCloseTo(1, 9);
    // Seed-then-hold well beyond the intensity ceiling → faint floor (0).
    const far = runSequence("B", [INTENSITY_RANGE_KM * 2, INTENSITY_RANGE_KM * 2]);
    expect(far[far.length - 1].level).toBe(0);
  });
});
