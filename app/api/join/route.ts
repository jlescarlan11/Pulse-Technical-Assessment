import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyPrivacyOffset, isValidLatLng } from "@/lib/geo";
import { isValidId } from "@/lib/validate";
import {
  checkRateLimit,
  RATE_LIMITS,
  RATE_LIMIT_WINDOW_MS,
} from "@/lib/ratelimit";
import type { JoinResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/join — body { id, lat, lng } (raw coords).
// Applies a 1–3 km privacy offset and upserts the presence row. Raw
// coordinates are never stored. Mints a fresh capability token on every join
// (rotate-on-join: the latest join wins and owns the session) and returns it to
// the client exactly once.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { id, lat, lng } = (body ?? {}) as Record<string, unknown>;

  if (!isValidId(id)) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }
  if (!isValidLatLng(lat, lng)) {
    return Response.json({ error: "invalid coordinates" }, { status: 400 });
  }

  // No token yet on join, so rate-limit by the provided session id.
  const { allowed } = await checkRateLimit(
    id,
    "join",
    RATE_LIMITS.join,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!allowed) {
    return Response.json({ error: "rate limited" }, { status: 429 });
  }

  const offset = applyPrivacyOffset(lat as number, lng as number);
  const token = randomUUID();

  await prisma.presence.upsert({
    where: { id },
    create: {
      id,
      token,
      lat: offset.lat,
      lng: offset.lng,
      busy: false,
      lastSeen: new Date(),
    },
    update: {
      token,
      lat: offset.lat,
      lng: offset.lng,
      lastSeen: new Date(),
    },
  });

  const response: JoinResponse = { ok: true, token };
  return Response.json(response);
}
