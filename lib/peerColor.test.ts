import { peerHue, peerColor } from "./peerColor";

describe("peerColor", () => {
  // A spread of ids to exercise the hash across many hue outcomes.
  const ids = Array.from({ length: 500 }, (_, i) => `peer-${i}-${i * 7}`);

  it("is deterministic for a given id", () => {
    expect(peerColor("abc-123")).toBe(peerColor("abc-123"));
    expect(peerHue("abc-123")).toBe(peerHue("abc-123"));
  });

  it("never produces a hue in the reserved signal-mint wedge (130–189°)", () => {
    for (const id of ids) {
      const h = peerHue(id);
      expect(h < 130 || h >= 190).toBe(true);
    }
  });

  it("keeps every hue within a valid 0–359° range", () => {
    for (const id of ids) {
      const h = peerHue(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("pins saturation and lightness so the palette stays cohesive", () => {
    for (const id of ids.slice(0, 20)) {
      expect(peerColor(id)).toMatch(/^hsl\(\d+, 85%, 64%\)$/);
    }
  });
});
