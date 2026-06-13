import { callSign, CALLSIGN_ADJECTIVES, CALLSIGN_NOUNS } from "./callsign";

describe("callSign", () => {
  // A spread of ids to exercise the hash across many handle outcomes.
  const ids = Array.from({ length: 500 }, (_, i) => `peer-${i}-${i * 7}`);

  it("is deterministic for a given id (repeated + stable)", () => {
    expect(callSign("abc-123")).toBe(callSign("abc-123"));
    const first = callSign("abc-123");
    for (let i = 0; i < 5; i++) {
      expect(callSign("abc-123")).toBe(first);
    }
  });

  it("returns exactly two capitalized words", () => {
    for (const id of ids) {
      const handle = callSign(id);
      const words = handle.split(" ");
      expect(words).toHaveLength(2);
      for (const word of words) {
        expect(word).toMatch(/^[A-Z][a-z]+$/);
      }
    }
  });

  it("draws each word from the curated wordlists", () => {
    for (const id of ids.slice(0, 50)) {
      const [adjective, noun] = callSign(id).split(" ");
      expect(CALLSIGN_ADJECTIVES).toContain(adjective);
      expect(CALLSIGN_NOUNS).toContain(noun);
    }
  });

  it("uses 64-entry wordlists with no duplicate words", () => {
    expect(CALLSIGN_ADJECTIVES).toHaveLength(64);
    expect(CALLSIGN_NOUNS).toHaveLength(64);
    expect(new Set(CALLSIGN_ADJECTIVES).size).toBe(64);
    expect(new Set(CALLSIGN_NOUNS).size).toBe(64);
  });

  it("keeps the two wordlists disjoint (no word in both → adjective ≠ noun)", () => {
    // A shared token would make a same-word handle ("Dusk Dusk") reachable,
    // which reads like a bug. Disjoint lists make that impossible by
    // construction — the adjective slot can never equal the noun slot.
    const adjectives = new Set(CALLSIGN_ADJECTIVES);
    const shared = CALLSIGN_NOUNS.filter((noun) => adjectives.has(noun));
    expect(shared).toEqual([]);
  });

  it("keeps the app's own 'signal/beacon' vocabulary out of NOUNS", () => {
    // Avoids the "Quiet Signal" tautology and keeps the no-id FALLBACK a
    // unique, unreachable handle (see the fallback test below).
    expect(CALLSIGN_NOUNS).not.toContain("Signal");
    expect(CALLSIGN_NOUNS).not.toContain("Beacon");
  });

  it("generally produces different handles for different ids", () => {
    const handles = new Set(ids.map((id) => callSign(id)));
    // Not all 500 are unique (collisions are acceptable by design), but the
    // hash should spread widely — expect well over half distinct.
    expect(handles.size).toBeGreaterThan(250);
  });

  it("returns the safe fallback for empty / undefined input", () => {
    expect(callSign("")).toBe("Quiet Signal");
    expect(callSign(undefined)).toBe("Quiet Signal");
    // Never crashes and never emits an "undefined" token.
    expect(callSign(undefined)).not.toMatch(/undefined/i);
  });

  it("never produces the reserved fallback handle for a real id", () => {
    // "Signal" is absent from NOUNS, so no real id can ever render the
    // FALLBACK — it stays a safe, unambiguous no-peer marker.
    for (const id of ids) {
      expect(callSign(id)).not.toBe("Quiet Signal");
    }
  });
});
