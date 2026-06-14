// Phase 4 "Block & Next" — the two pure block DECISIONS, extracted so they can
// be unit-tested without mounting the whole page (WebRTC, geolocation, the poll
// loop). page.tsx still owns the ephemeral in-memory Set<string> (a ref that
// dies with the tab); these helpers are stateless predicates over whatever Set
// the caller passes in.
//
// HONESTY INVARIANT (stakeholder): the blocklist is session-scoped and in
// memory only. There is deliberately NO persistence here — no localStorage, no
// DB, no Date — so a reloaded peer (new per-page-load id) is never matched. The
// Set's lifetime is owned by the caller's ref, which is recreated on remount.

import type { PeerDot } from "@/lib/types";

/**
 * Discovery filter: drop any peer whose id is in the blocklist. Used at the
 * poll tick so blocked peers vanish from the map dots, the accessible "Nearby
 * signals" list, and the count (all derive from this one array). Pure: returns
 * a new array, never mutates the input.
 * @param peers - The peers returned by the latest poll.
 * @param blocked - The session blocklist of refused peer ids.
 * @returns The peers minus any blocked id.
 */
export function filterBlockedPeers(
  peers: PeerDot[],
  blocked: ReadonlySet<string>,
): PeerDot[] {
  return peers.filter((p) => !blocked.has(p.id));
}

/**
 * Auto-decline predicate: true when an inbound connection request is from a
 * blocked peer and must be silently declined (no incoming prompt). The caller
 * emits the SAME "decline" a busy/ignored request produces, so a blocked peer
 * can't distinguish a block from an ordinary decline — no "you are blocked" is
 * ever leaked.
 * @param fromId - The id of the peer that sent the request.
 * @param blocked - The session blocklist of refused peer ids.
 * @returns true if the request should be auto-declined.
 */
export function isBlockedRequest(
  fromId: string,
  blocked: ReadonlySet<string>,
): boolean {
  return blocked.has(fromId);
}
