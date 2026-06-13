// Client-side helpers for talking to the coordination API.
import type { JoinResponse, PollResponse, SignalType } from "@/lib/types";

// Thrown when the API rejects a call for an authorization/capability reason
// (HTTP 401). The caller (page.tsx) catches this to re-mint a fresh token by
// re-joining, rather than letting the session silently die.
export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

// join registers presence and returns the per-session capability token.
// The token is issued exactly once here; the caller must keep it for the
// session and present it on every subsequent poll/signal/leave/turn call.
// (Re-joining rotates the token.)
export async function join(
  id: string,
  lat: number,
  lng: number,
): Promise<JoinResponse> {
  const res = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, lat, lng }),
  });
  if (!res.ok) {
    throw new Error(`join failed: ${res.status}`);
  }
  return res.json();
}

export async function poll(id: string, token: string): Promise<PollResponse> {
  const res = await fetch(
    `/api/poll?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,
    { cache: "no-store" },
  );
  if (res.status === 401) {
    throw new UnauthorizedError("poll unauthorized");
  }
  if (!res.ok) {
    throw new Error(`poll failed: ${res.status}`);
  }
  return res.json();
}

export async function sendSignal(
  fromId: string,
  toId: string,
  type: SignalType,
  token: string,
  payload?: string,
): Promise<void> {
  const res = await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromId, toId, type, payload, token }),
  });
  if (res.status === 401) {
    throw new UnauthorizedError("signal unauthorized");
  }
}

// Fire-and-forget leave that survives the tab closing. The capability token is
// carried in the JSON body so it stays sendBeacon-compatible (sendBeacon sends
// a blob/body, never query params or custom headers).
export function leave(id: string, token: string): void {
  const body = JSON.stringify({ id, token });
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon("/api/leave", body);
  } else {
    void fetch("/api/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
  }
}
