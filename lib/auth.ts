import { timingSafeEqual } from "node:crypto";

// Capability-token verification. Every Presence row owns a server-issued secret
// (minted on join). poll/leave/signal/turn-credentials all prove they own a
// session by presenting this token. The token value is NEVER logged.

// The shape we need off a Presence row to verify. Kept minimal so callers can
// `select: { token: true }` and nothing else.
export interface TokenBearer {
  token: string;
}

// Constant-time comparison of the provided token against the stored one. Returns
// false for a missing row, a non-string / empty provided token, or any length
// mismatch — we length-guard first because timingSafeEqual throws on unequal
// buffer lengths.
export function verifyToken(
  presenceRow: TokenBearer | null | undefined,
  providedToken: unknown,
): boolean {
  if (!presenceRow || typeof providedToken !== "string" || !providedToken) {
    return false;
  }

  const stored = Buffer.from(presenceRow.token, "utf8");
  const provided = Buffer.from(providedToken, "utf8");

  if (stored.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(stored, provided);
}
