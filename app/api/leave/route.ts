import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/auth";
import { isValidId } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/leave — body { id, token }. Removes the presence row and any pending
// signals to/from this user. Called via navigator.sendBeacon on tab close, so
// the body may arrive as text — parse defensively. The token travels in the body
// (sendBeacon can't set headers) and gates the delete.
export async function POST(request: NextRequest) {
  let id: unknown;
  let token: unknown;
  try {
    const text = await request.text();
    const parsed = text ? JSON.parse(text) : {};
    id = parsed?.id;
    token = parsed?.token;
  } catch {
    id = undefined;
    token = undefined;
  }

  if (!isValidId(id)) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  // Verify the caller owns this session before deleting anything.
  const owner = await prisma.presence.findUnique({
    where: { id },
    select: { token: true },
  });
  if (!verifyToken(owner, token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Independent cleanup deletes — no atomicity needed (and interactive
  // transactions are unreliable over a PgBouncer pooler).
  await prisma.signal.deleteMany({
    where: { OR: [{ toId: id }, { fromId: id }] },
  });
  await prisma.presence.deleteMany({ where: { id } });

  return Response.json({ ok: true });
}
