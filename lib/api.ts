// Client-side helpers for talking to the coordination API.
import type { PollResponse, SignalType } from "@/lib/types";

export async function join(
  id: string,
  lat: number,
  lng: number,
): Promise<void> {
  await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, lat, lng }),
  });
}

export async function poll(id: string): Promise<PollResponse> {
  const res = await fetch(`/api/poll?id=${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    console.error(`[DEBUG] poll failed: ${res.status}`);
    throw new Error(`poll failed: ${res.status}`);
  }
  const data = await res.json();
  if (data.signals && data.signals.length > 0) {
    console.log("[DEBUG] poll returned", data.signals.length, "signals");
  }
  return data;
}

export async function sendSignal(
  fromId: string,
  toId: string,
  type: SignalType,
  payload?: string,
): Promise<void> {
  console.log("[DEBUG] sendSignal:", type, "from", fromId.substring(0, 8), "to", toId.substring(0, 8));
  const res = await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromId, toId, type, payload }),
  });
  if (!res.ok) {
    console.error("[DEBUG] sendSignal failed:", res.status);
  }
}

// Fire-and-forget leave that survives the tab closing.
export function leave(id: string): void {
  const body = JSON.stringify({ id });
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
