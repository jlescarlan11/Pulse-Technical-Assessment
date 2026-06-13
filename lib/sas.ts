// Short Authentication String (SAS) verification — Pulse Phase 4.
//
// WebRTC's SDP carries each peer's DTLS certificate fingerprint
// (`a=fingerprint:sha-256 AB:CD:...`). Our /api/signal mailbox relays SDP, so a
// malicious relay could swap a fingerprint to insert itself as a man in the
// middle. To detect this, both peers independently derive a short phrase from
// BOTH fingerprints. Identical inputs (order-independent) produce an identical
// phrase on both ends, so if the humans see the same phrase the channel was not
// tampered with. The phrase is compared by humans (read aloud / shown on video).
//
// No React/DOM dependency lives here: this is a pure crypto + string util built
// on Web Crypto `crypto.subtle`, available in browsers and Node 20+ as a global.

import { SAS_WORDLIST, type SasToken } from "./sas-wordlist";

// Baked into the hash input so a future wordlist or algorithm change cannot
// silently produce a phrase that "looks" valid against an old client. Bump this
// whenever the wordlist ordering, token count, or derivation changes.
export const SAS_VERSION = "pulse-sas-v2";

// Number of tokens in a phrase. With a 256-entry wordlist, each token consumes
// exactly one hash byte (1 byte = 1 of 2^8 words, no modulo bias). 5 tokens give
// 40 bits of entropy — 256x harder for an active MITM to grind than 4 tokens.
const SAS_TOKEN_COUNT = 5;

// Separator between the two fingerprints in the hash preimage. A character that
// never appears in a normalized fingerprint (hex + colons + algo + space) so
// the two halves can never be ambiguously concatenated.
const FINGERPRINT_SEPARATOR = "|";

export type SasPhrase = SasToken[];

/**
 * Extracts and normalizes the DTLS fingerprint from an SDP string.
 *
 * Looks for the first `a=fingerprint:<algo> <hex>` line (Pulse uses a single
 * peer connection, so the session-level / first fingerprint is authoritative)
 * and returns a canonical form: `<algo> <hex>`, lowercased, whitespace and
 * CR/LF stripped. Returns null if no valid fingerprint line is present (the
 * "verification unavailable" path the UI must handle).
 *
 * @param sdp - Raw SDP from a local or remote session description.
 * @returns Normalized `"<algo> <uppercase-stripped hex lowercased>"` or null.
 */
export function parseFingerprint(sdp: string): string | null {
  if (typeof sdp !== "string" || sdp.length === 0) return null;

  // Match "a=fingerprint:<algo> <value>" tolerant of leading whitespace and
  // CRLF line endings; capture the algorithm and the colon-separated hex value.
  const match = sdp.match(/^[ \t]*a=fingerprint:(\S+)[ \t]+(\S+)[ \t]*\r?$/im);
  if (!match) return null;

  const algo = match[1].trim().toLowerCase();
  const value = match[2].trim().toLowerCase();
  if (!algo || !value) return null;

  return `${algo} ${value}`;
}

/**
 * Derives a deterministic, order-independent SAS phrase from two normalized
 * fingerprints.
 *
 * The two fingerprints are sorted lexicographically (so A,B and B,A produce the
 * same preimage), joined with a separator, prefixed with SAS_VERSION, hashed
 * with SHA-256, and the first SAS_TOKEN_COUNT bytes index into the 256-entry
 * wordlist — one byte per token.
 *
 * @param fpA - A normalized fingerprint (e.g. from parseFingerprint).
 * @param fpB - The other normalized fingerprint.
 * @returns SAS_TOKEN_COUNT tokens; identical on both peers iff no tampering.
 */
export async function deriveSAS(fpA: string, fpB: string): Promise<SasPhrase> {
  const [first, second] = [fpA, fpB].sort();
  const preimage = `${SAS_VERSION}${FINGERPRINT_SEPARATOR}${first}${FINGERPRINT_SEPARATOR}${second}`;

  const data = new TextEncoder().encode(preimage);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);

  const phrase: SasPhrase = [];
  for (let i = 0; i < SAS_TOKEN_COUNT; i++) {
    phrase.push(SAS_WORDLIST[bytes[i]]);
  }
  return phrase;
}
