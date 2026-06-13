import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/auth";
import { isValidId } from "@/lib/validate";
import {
  checkRateLimit,
  RATE_LIMITS,
  RATE_LIMIT_WINDOW_MS,
} from "@/lib/ratelimit";
import type { SignalType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES: SignalType[] = [
  "request",
  "accept",
  "decline",
  "offer",
  "answer",
  "ice",
  "end",
];

const MAX_PAYLOAD = 64 * 1024; // SDP/ICE are small; cap to be safe.

// POST /api/signal — body { fromId, toId, type, payload?, token }
// Drops one message into the recipient's mailbox. Also manages the `busy`
// flag so a user can only be in one connection at a time. The token (in the
// body) must match fromId's session — this is what blocks fromId spoofing/MITM.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { fromId, toId, type, payload, token } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (!isValidId(fromId) || !isValidId(toId)) {
    return Response.json({ error: "invalid ids" }, { status: 400 });
  }
  if (typeof type !== "string" || !VALID_TYPES.includes(type as SignalType)) {
    return Response.json({ error: "invalid type" }, { status: 400 });
  }
  // Bounded payload: when present it must be a string within the size cap. We do
  // NOT parse SDP/ICE contents — this is the bounded check, not validation.
  if (
    payload !== undefined &&
    payload !== null &&
    (typeof payload !== "string" || payload.length > MAX_PAYLOAD)
  ) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  // Verify the sender owns fromId before touching any busy flags or the mailbox.
  const sender = await prisma.presence.findUnique({
    where: { id: fromId },
    select: { token: true },
  });
  if (!verifyToken(sender, token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Authenticated — rate-limit by sender id (hashed inside the limiter).
  const { allowed } = await checkRateLimit(
    fromId,
    "signal",
    RATE_LIMITS.signal,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!allowed) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }

  const signalType = type as SignalType;
  const payloadStr = typeof payload === "string" ? payload : null;

  // Enforce "one active connection at a time": if the target is already busy,
  // auto-decline the request instead of delivering it.
  if (signalType === "request") {
    const target = await prisma.presence.findUnique({
      where: { id: toId },
      select: { busy: true },
    });
    if (!target) {
      // Target went offline — tell the initiator it was declined.
      await sendDecline(toId, fromId);
      return Response.json({ ok: true, autoDeclined: true });
    }
    if (target.busy) {
      await sendDecline(toId, fromId);
      return Response.json({ ok: true, autoDeclined: true });
    }
  }

  // Busy transitions:
  // - accept: the connection is now active → mark BOTH peers busy.
  // - decline/end: free both peers.
  if (signalType === "accept") {
    await prisma.presence.updateMany({
      where: { id: { in: [fromId, toId] } },
      data: { busy: true },
    });
  } else if (signalType === "decline" || signalType === "end") {
    await prisma.presence.updateMany({
      where: { id: { in: [fromId, toId] } },
      data: { busy: false },
    });
  }

  await prisma.signal.create({
    data: { fromId, toId, type: signalType, payload: payloadStr },
  });

  return Response.json({ ok: true });
}

// Helper: deliver an auto-decline from `target` back to `initiator`.
async function sendDecline(targetId: string, initiatorId: string) {
  await prisma.signal.create({
    data: { fromId: targetId, toId: initiatorId, type: "decline", payload: null },
  });
}
