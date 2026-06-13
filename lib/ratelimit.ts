import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Fixed-window, Postgres-backed rate limiter. Designed for Vercel serverless
// behind a connection pooler: a single atomic upsert, no transactions.
//
// CRITICAL: this is FAIL-OPEN. Any error (DB unreachable, etc.) returns
// { allowed: true } so the limiter can never lock out legitimate users — it is
// abuse mitigation, not an authz control. The token check is what actually
// gates access.
//
// The caller identifier is sha256-hashed before it touches the table, so no raw
// session id / token is ever persisted in RateLimit.

export type RateLimitRoute = "join" | "signal" | "poll";

export async function checkRateLimit(
  key: string,
  route: RateLimitRoute,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean }> {
  try {
    const now = Date.now();
    const window = Math.floor(now / windowMs) * windowMs;
    const expiresAt = new Date(window + windowMs);
    const hashedKey = createHash("sha256").update(key).digest("hex");

    // Atomic increment-and-return: insert the window row, or bump the existing
    // counter, in one statement. Parameterized to avoid any injection.
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimit" ("key", "route", "window", "count", "expiresAt")
      VALUES (${hashedKey}, ${route}, ${BigInt(window)}, 1, ${expiresAt})
      ON CONFLICT ("key", "route", "window")
      DO UPDATE SET "count" = "RateLimit"."count" + 1
      RETURNING "count"
    `;

    const count = rows[0]?.count ?? 0;
    return { allowed: count <= limit };
  } catch {
    // Fail open — never throw, never log the key.
    return { allowed: true };
  }
}

// Window length shared across routes (10s). Per-route thresholds give normal
// clients (poll every 1500ms) well over 4x headroom.
export const RATE_LIMIT_WINDOW_MS = 10_000;
export const RATE_LIMITS: Record<RateLimitRoute, number> = {
  poll: 30,
  signal: 60,
  join: 10,
};
