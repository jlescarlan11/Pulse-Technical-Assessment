/**
 * Tier 2 camera filters — pure-preset unit tests.
 *
 * videoFilters.ts is the single source of truth shared by BOTH the transmit
 * path (lib/webrtc.ts canvas ctx.filter) and the self-view preview
 * (VideoPanel <video> CSS filter). These tests pin the contract those two
 * consumers depend on:
 *
 *   - getFilterPreset() always returns a REAL preset; unknown / malformed ids
 *     (incl. empty / null / undefined) degrade to the safe "none" passthrough
 *     and never throw.
 *   - The preset set is stable: ids, order, labels, and the css invariants
 *     ("none" is empty; grades are non-empty and carry no privacy-claiming
 *     blur).
 *
 * Pure functions / constants only — no DOM, no fakes. Mirrors the lib/*.test.ts
 * unit style (peerColor.test.ts, callsign.test.ts).
 */
import {
  FILTER_PRESETS,
  DEFAULT_FILTER_ID,
  getFilterPreset,
  type FilterPresetId,
} from "./videoFilters";

const VALID_IDS: FilterPresetId[] = ["none", "night", "warm", "mono"];

describe("getFilterPreset", () => {
  it("returns the matching preset for each valid id", () => {
    for (const id of VALID_IDS) {
      expect(getFilterPreset(id).id).toBe(id);
    }
  });

  it("defaults to 'none' for unknown / empty / null / undefined ids", () => {
    expect(getFilterPreset("nope").id).toBe("none");
    expect(getFilterPreset("").id).toBe("none");
    expect(getFilterPreset(null).id).toBe("none");
    expect(getFilterPreset(undefined).id).toBe("none");
    // A stale or hostile id is treated as the safe passthrough, never a throw.
    expect(getFilterPreset("Night ").id).toBe("none"); // trailing space != "night"
    expect(getFilterPreset("NIGHT").id).toBe("none"); // ids are lowercase
  });

  it("the fallback preset is the canonical 'none' object (first entry)", () => {
    // Not just any none-shaped object — the same singleton the rest of the app
    // matches by reference / value, so preview and transmit can't drift.
    expect(getFilterPreset("nope")).toBe(FILTER_PRESETS[0]);
    expect(getFilterPreset(undefined).css).toBe("");
  });

  it("always returns a real preset (never undefined) for arbitrary junk", () => {
    for (const junk of ["", "  ", "blur", "{}", "0", "true"]) {
      const p = getFilterPreset(junk);
      expect(p).toBeDefined();
      expect(VALID_IDS).toContain(p.id);
    }
  });
});

describe("FILTER_PRESETS — stable contract", () => {
  it("DEFAULT_FILTER_ID is 'none' and is the first preset", () => {
    expect(DEFAULT_FILTER_ID).toBe("none");
    expect(FILTER_PRESETS[0].id).toBe(DEFAULT_FILTER_ID);
  });

  it("exposes exactly none/night/warm/mono in that order", () => {
    expect(FILTER_PRESETS.map((p) => p.id)).toEqual(VALID_IDS);
  });

  it("labels are the stable uppercase names the UI renders", () => {
    expect(FILTER_PRESETS.map((p) => p.label)).toEqual([
      "NONE",
      "NIGHT",
      "WARM",
      "MONO",
    ]);
  });

  it("'none' carries an empty css (true passthrough that enables the bypass)", () => {
    expect(getFilterPreset("none").css).toBe("");
  });

  it("every GRADE has a non-empty css and never a privacy-claiming blur", () => {
    for (const p of FILTER_PRESETS) {
      if (p.id === "none") continue;
      expect(p.css.length).toBeGreaterThan(0);
      // blur reads as a privacy claim; privacy is owned by the gate, not a grade.
      expect(p.css).not.toContain("blur");
    }
  });
});
