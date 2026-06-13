// A peer's verbal call-sign — a stable, deterministic two-word handle
// ("Adjective Noun") derived from their peer id, shown alongside the existing
// peerColor across the map, the connection prompt, and the chat header.
//
// This is an EPHEMERAL per-session signal label — a human-memorable referent
// for "which signal is this", NOT a name, username, or account, and it carries
// no persistence across sessions. It is the spoken-word layer over the visual
// peerColor identity (which already guarantees visual uniqueness), so the
// call-sign is allowed to collide; there is intentionally no disambiguation.
//
// Tone is curated once, here, to match "Signal in the Dark": atmospheric,
// quiet-night register, single-token words, no proper nouns, no aggression,
// no anatomy, nothing that reads creepy or gendered on an anonymous app.
//
// The two lists are kept DISJOINT (no word appears in both), so a same-word
// pairing like "Dusk Dusk" is impossible by construction — never a bug-looking
// handle. None of the nouns reuse the app's own "signal/beacon" vocabulary, so
// the FALLBACK below ("Quiet Signal") can never be produced by a real id.

// Exactly 64 entries (a power of two) so a 6-bit hash slice maps with a `& 63`
// mask — no modulo bias.
const ADJECTIVES: readonly string[] = [
  "Quiet", "Distant", "Amber", "Wispy", "Drifting", "Faint", "Still", "Nocturnal",
  "Hushed", "Pale", "Velvet", "Misty", "Silent", "Dim", "Soft", "Lone",
  "Calm", "Muted", "Shaded", "Hazy", "Gentle", "Dark", "Cool", "Slow",
  "Frosted", "Glassy", "Smoky", "Ashen", "Dusty", "Dewy", "Foggy", "Cloudy",
  "Shadowed", "Twilit", "Moonlit", "Starlit", "Dimmed", "Lunar", "Northern", "Hidden",
  "Far", "Deep", "Low", "Wandering", "Roaming", "Fading", "Lingering", "Floating",
  "Sleepy", "Dreaming", "Tranquil", "Placid", "Serene", "Mellow", "Tender", "Subtle",
  "Veiled", "Cloaked", "Wintry", "Autumn", "Coastal", "Riverine", "Inland", "Open",
] as const;

const NOUNS: readonly string[] = [
  "Fox", "Harbor", "Ember", "Gloaming", "Tide", "Lantern", "Heron", "Drift",
  "Hollow", "Meadow", "Willow", "Cedar", "Pine", "Birch", "Aspen", "Maple",
  "Glade", "Grove", "Marsh", "Fjord", "Cove", "Inlet", "Reef", "Shoal",
  "Solstice", "Compass", "Anchor", "Sail", "Mast", "Wharf", "Pier", "Dock",
  "Owl", "Crane", "Finch", "Swift", "Wren", "Lark", "Raven", "Robin",
  "Otter", "Marten", "Hare", "Lynx", "Stoat", "Vole", "Badger", "Pika",
  "Comet", "Nebula", "Aurora", "Twilight", "Dawn", "Dusk", "Mist", "Haze",
  "Echo", "Whisper", "Murmur", "Hush", "Lull", "Glow", "Spark", "Glimmer",
] as const;

const MASK = 0x3f; // 63 — selects 6 bits, matching the 64-entry wordlists.

// Neutral handle for empty / undefined ids: never crash, never "undefined Noun".
// "Signal" is intentionally NOT in NOUNS, so this stays a unique, unreachable
// fallback that no real peerId can collide with.
const FALLBACK = "Quiet Signal";

/**
 * Deterministically derives a two-word "Adjective Noun" call-sign from a peer
 * id. Pure, synchronous, no storage, no randomness, no Date. The same id always
 * yields the same handle. Collisions are acceptable (peerColor owns uniqueness).
 * @param peerId - The peer's session id.
 * @returns A two-word capitalized handle (e.g. "Quiet Fox"), or a neutral
 *   fallback for an empty / undefined id.
 */
export function callSign(peerId: string | undefined): string {
  if (!peerId) return FALLBACK;

  // FNV-1a hash (same family as lib/peerColor's hashing voice).
  let h = 0x811c9dc5;
  for (let i = 0; i < peerId.length; i++) {
    h ^= peerId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const u = h >>> 0;

  // Two DIFFERENT 6-bit slices: low bits → adjective, high bits → noun, so the
  // two words vary independently rather than tracking each other.
  const adjective = ADJECTIVES[u & MASK];
  const noun = NOUNS[(u >>> 13) & MASK];

  return `${adjective} ${noun}`;
}

// Exposed for tests (wordlist sizes + duplicate-word assertions).
export const CALLSIGN_ADJECTIVES = ADJECTIVES;
export const CALLSIGN_NOUNS = NOUNS;
