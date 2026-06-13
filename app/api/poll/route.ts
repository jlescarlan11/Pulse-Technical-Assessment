import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { STALE_MS, SIGNAL_TTL_MS } from "@/lib/presence";
import { verifyToken } from "@/lib/auth";
import { isValidId } from "@/lib/validate";
import {
  checkRateLimit,
  RATE_LIMITS,
  RATE_LIMIT_WINDOW_MS,
} from "@/lib/ratelimit";
import type { PollResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/poll?id=&token= — the single endpoint that drives the live map.
// It (1) verifies the caller owns the session via its capability token,
// (2) heartbeats the caller, (3) reaps stale presence + orphan signals,
// (4) returns the filtered online peers, and (5) drains this user's mailbox.
// Peer list NEVER exposes the token.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = params.get("id");
  const token = params.get("token");

  if (!isValidId(id)) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  // Verify the capability token BEFORE any heartbeat / reap / read. A missing
  // row or a token mismatch is unauthenticated: do nothing.
  const owner = await prisma.presence.findUnique({
    where: { id },
    select: { token: true },
  });
  if (!verifyToken(owner, token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Authenticated — rate-limit by session id (hashed inside the limiter).
  const { allowed } = await checkRateLimit(
    id,
    "poll",
    RATE_LIMITS.poll,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!allowed) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }

  const now = Date.now();
  const staleCutoff = new Date(now - STALE_MS);
  const signalCutoff = new Date(now - SIGNAL_TTL_MS);

  // 1) Heartbeat — refresh lastSeen for the caller.
  await prisma.presence.updateMany({
    where: { id },
    data: { lastSeen: new Date(now) },
  });

  // 2) Reap stale presence rows, orphaned signals, and expired rate-limit
  // windows (independent deletes — no atomicity needed, and avoids transactions
  // over a PgBouncer pooler).
  await prisma.presence.deleteMany({
    where: { lastSeen: { lt: staleCutoff } },
  });
  await prisma.signal.deleteMany({ where: { createdAt: { lt: signalCutoff } } });
  await prisma.rateLimit.deleteMany({
    where: { expiresAt: { lt: new Date(now) } },
  });

  // 3) Online peers, excluding self. Token deliberately NOT selected.
  const peers = await prisma.presence.findMany({
    where: {
      id: { not: id },
      lastSeen: { gte: staleCutoff },
    },
    select: { id: true, lat: true, lng: true, busy: true },
  });

  // 4) Drain this user's mailbox: read, then delete exactly what we read so a
  // concurrently-inserted signal is never lost.
  const inbox = await prisma.signal.findMany({
    where: { toId: id },
    orderBy: { createdAt: "asc" },
  });
  if (inbox.length > 0) {
    await prisma.signal.deleteMany({
      where: { id: { in: inbox.map((s) => s.id) } },
    });
  }

  const response: PollResponse = {
    peers: peers.map((p) => ({
      id: p.id,
      lat: p.lat,
      lng: p.lng,
      busy: p.busy,
    })),
    signals: inbox.map((s) => ({
      id: s.id,
      fromId: s.fromId,
      toId: s.toId,
      type: s.type as PollResponse["signals"][number]["type"],
      payload: s.payload,
      createdAt: s.createdAt.toISOString(),
    })),
  };

  return Response.json(response);
}
