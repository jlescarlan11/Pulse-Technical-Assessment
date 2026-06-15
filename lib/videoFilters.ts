// Tier 2 camera filters — the single source of truth for the preset set.
//
// A camera "filter" here is strictly a COSMETIC color-grade: a CSS `filter`
// string built from only the standard, well-supported filter functions
// (grayscale/sepia/brightness/contrast/saturate/hue-rotate). There is NO face
// detection, AR, ML, beauty, or virtual-background processing, and explicitly
// NO blur — blur would read as a privacy claim, and privacy in this app is
// owned by the presence gate (track.enabled), never by a cosmetic filter.
//
// The SAME `css` string is consumed in two places that must never drift:
//   1. lib/webrtc.ts applies it as a canvas 2D `ctx.filter` on the TRANSMITTED
//      (peer-bound) frames.
//   2. the frontend self-view applies it as a CSS `filter` on the local
//      <video> element so the user previews exactly what the peer receives.
// Because both import this one constant, the transmit grade and the preview
// grade are guaranteed identical.

/** Stable, serializable preset identifier. "none" is the passthrough default. */
export type FilterPresetId = "none" | "night" | "warm" | "mono";

export interface FilterPreset {
  /** Stable id — safe to persist / send; the lookup key. */
  readonly id: FilterPresetId;
  /** Short uppercase label for the UI control. */
  readonly label: string;
  /**
   * CSS filter string. Valid BOTH as a canvas `ctx.filter` value AND as a CSS
   * `filter` on a <video>. "" for "none" — an empty filter is a true
   * passthrough (and lets the transmit path take its zero-cost bypass).
   */
  readonly css: string;
}

// Ordered list. "none" MUST be first: it is the default, the common case, and
// the UI renders presets in this order. Grades are deliberately subtle and tuned
// for a dark, moody app — enough to read as a distinct mood, never a costume.
export const FILTER_PRESETS: readonly FilterPreset[] = [
  // Passthrough. Empty css => the webrtc transmit path skips the canvas stage
  // entirely (zero cost at rest). Always first.
  { id: "none", label: "NONE", css: "" },
  // "Night": cooler, dimmer, higher-contrast — leans into the dark theme. A
  // gentle hue-rotate pushes skin/scene toward blue without going sci-fi.
  {
    id: "night",
    label: "NIGHT",
    css: "brightness(0.85) contrast(1.15) saturate(0.85) hue-rotate(200deg)",
  },
  // "Warm": a soft, candle-lit sepia wash with a touch more brightness — cozy
  // against the dark UI without blowing out highlights.
  {
    id: "warm",
    label: "WARM",
    css: "sepia(0.45) saturate(1.25) brightness(1.05) contrast(1.05)",
  },
  // "Mono": full grayscale with a slight contrast lift for a moody, filmic look.
  {
    id: "mono",
    label: "MONO",
    css: "grayscale(1) contrast(1.1) brightness(0.95)",
  },
] as const;

// The default applied at startup and the honest fallback when the canvas
// pipeline is unavailable or fails. Guaranteed present (it is the first entry).
export const DEFAULT_FILTER_ID: FilterPresetId = "none";

/**
 * Resolve a preset by id. Unknown / malformed ids default to "none" so a stale
 * or hostile id can never select a non-existent grade or throw — it degrades to
 * the safe passthrough. Always returns a real preset.
 */
export function getFilterPreset(id: string | null | undefined): FilterPreset {
  const found = FILTER_PRESETS.find((p) => p.id === id);
  return found ?? FILTER_PRESETS[0];
}
