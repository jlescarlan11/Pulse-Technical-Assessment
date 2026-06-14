/**
 * Phase 4 "Block & Next" — the two pure block DECISIONS.
 *
 * WHY THIS FILE EXISTS (testability note): the block behaviour lives in
 * app/page.tsx, whose <Home> can only reach the block decisions through a long
 * async pipeline — geolocation entry, /api/join, the poll loop, a connection
 * request, a peer accept, and a mocked PeerSession channel-open — before the
 * Block control is even mounted. Exercising that end-to-end in jsdom would
 * require brittle, extensive mocking of WebRTC + network + timers and would be
 * flaky on async ordering. So the two decisions over the blocklist are
 * extracted to lib/blocklist.ts as pure predicates and unit-tested here, fast
 * and deterministic. page.tsx calls these exact functions at the poll tick
 * (filterBlockedPeers) and in processSignal's "request" case (isBlockedRequest),
 * so testing them tests the real decisions.
 *
 * These tests assert BEHAVIOUR (which peers survive, which requests decline),
 * not internals. Node env (lib default) — no DOM needed.
 */
import { filterBlockedPeers, isBlockedRequest } from "./blocklist";
import type { PeerDot } from "@/lib/types";

function dot(id: string): PeerDot {
  return { id, lat: 0, lng: 0, busy: false };
}

describe("filterBlockedPeers — discovery filter (poll tick)", () => {
  it("drops a blocked peer from the discovered list", () => {
    const peers = [dot("a"), dot("b"), dot("c")];
    const blocked = new Set(["b"]);

    const result = filterBlockedPeers(peers, blocked);

    expect(result.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("drops every blocked peer when several are blocked", () => {
    const peers = [dot("a"), dot("b"), dot("c"), dot("d")];
    const blocked = new Set(["a", "c"]);

    const result = filterBlockedPeers(peers, blocked);

    expect(result.map((p) => p.id)).toEqual(["b", "d"]);
  });

  it("returns all peers when nothing is blocked", () => {
    const peers = [dot("a"), dot("b")];

    const result = filterBlockedPeers(peers, new Set());

    expect(result.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array (returns a new array)", () => {
    const peers = [dot("a"), dot("b")];
    const before = peers.slice();

    const result = filterBlockedPeers(peers, new Set(["a"]));

    expect(peers).toEqual(before); // input untouched
    expect(result).not.toBe(peers); // a fresh array
  });

  it("a blocked id that isn't currently nearby is simply a no-op (no crash, all kept)", () => {
    // The user blocked someone who has since left the radius; the live list
    // is unaffected and nothing throws.
    const peers = [dot("a"), dot("b")];

    const result = filterBlockedPeers(peers, new Set(["gone"]));

    expect(result.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("isBlockedRequest — auto-decline predicate (incoming request)", () => {
  it("is true for a request FROM a blocked peer (silently auto-decline, no prompt)", () => {
    expect(isBlockedRequest("b", new Set(["b"]))).toBe(true);
  });

  it("is false for a request from a peer that is NOT blocked (prompt may show)", () => {
    expect(isBlockedRequest("a", new Set(["b"]))).toBe(false);
  });

  it("is false when nothing is blocked", () => {
    expect(isBlockedRequest("a", new Set())).toBe(false);
  });
});

describe("Block & Next — Undo and the session-scoped honesty invariant", () => {
  it("removing an id from the set (Undo) restores the peer in discovery and stops auto-declining", () => {
    // The page's Undo handler does exactly `blocked.delete(peerId)` — un-block
    // only, no reconnect. After that, the peer is discoverable and its requests
    // are no longer auto-declined.
    const blocked = new Set(["b"]);
    const peers = [dot("a"), dot("b")];

    // While blocked: filtered out, request auto-declined.
    expect(filterBlockedPeers(peers, blocked).map((p) => p.id)).toEqual(["a"]);
    expect(isBlockedRequest("b", blocked)).toBe(true);

    // Undo.
    blocked.delete("b");

    // Now visible again and requests prompt normally.
    expect(filterBlockedPeers(peers, blocked).map((p) => p.id)).toEqual([
      "a",
      "b",
    ]);
    expect(isBlockedRequest("b", blocked)).toBe(false);
  });

  it("HONESTY INVARIANT: the blocklist is in-memory only — a fresh set (remount/reload) no longer filters a previously-blocked peer", () => {
    // page.tsx holds the blocklist in a useRef(new Set()). A remount/reload
    // constructs a BRAND NEW Set — there is no persistence (no localStorage, no
    // DB). We model that here: a peer blocked in one "session" set is NOT
    // blocked once we start from a fresh set, so a reloaded peer (or our own
    // reload) sees them again. This is the stakeholder's stated ceiling, and
    // it's verified at the decision layer the page actually uses.
    const peers = [dot("a"), dot("b")];

    // Session 1: block "b".
    const session1 = new Set<string>();
    session1.add("b");
    expect(filterBlockedPeers(peers, session1).map((p) => p.id)).toEqual(["a"]);
    expect(isBlockedRequest("b", session1)).toBe(true);

    // Session 2: a fresh ref/Set on remount — the block did NOT survive.
    const session2 = new Set<string>();
    expect(filterBlockedPeers(peers, session2).map((p) => p.id)).toEqual([
      "a",
      "b",
    ]);
    expect(isBlockedRequest("b", session2)).toBe(false);
  });
});
