import { useCallback, useRef } from "react";
import { filterBlockedPeers, isBlockedRequest } from "@/lib/blocklist";
import type { PeerDot } from "@/lib/types";

export interface UseBlocklist {
  block: (id: string) => void;
  unblock: (id: string) => void;
  // True if an inbound connection request from this id should be auto-declined.
  isBlocked: (id: string) => boolean;
  // Exclude blocked peers from discovery (map dots + nearby list + count).
  filterPeers: (peers: PeerDot[]) => PeerDot[];
}

// An EPHEMERAL, in-memory set of peer ids the user has refused. Held in a ref
// ON PURPOSE: it is read synchronously inside the poll tick (discovery filter)
// and inside processSignal (auto-decline), and it must NOT survive the tab. No
// state, no localStorage, no DB — a peer is identified by a per-page-load UUID,
// so this set dies with the session and a reloaded peer gets a fresh identity.
// The two decisions over the set (discovery filter + auto-decline) stay as pure,
// unit-tested helpers in lib/blocklist.ts; this hook just owns the set and wraps
// them with referentially-stable callbacks (so the poll effect can list
// filterPeers in its deps without re-subscribing).
export function useBlocklist(): UseBlocklist {
  const blockedRef = useRef<Set<string>>(new Set());

  const block = useCallback((id: string) => {
    blockedRef.current.add(id);
  }, []);

  const unblock = useCallback((id: string) => {
    blockedRef.current.delete(id);
  }, []);

  const isBlocked = useCallback(
    (id: string) => isBlockedRequest(id, blockedRef.current),
    [],
  );

  const filterPeers = useCallback(
    (peers: PeerDot[]) => filterBlockedPeers(peers, blockedRef.current),
    [],
  );

  return { block, unblock, isBlocked, filterPeers };
}
