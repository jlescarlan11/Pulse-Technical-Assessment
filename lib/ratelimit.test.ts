// Mock the Prisma client before importing the limiter — the limiter issues a
// single $queryRaw upsert and reads the returned count.
jest.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: jest.fn(),
  },
}));

import { createHash } from "node:crypto";
import { checkRateLimit, RATE_LIMITS, RATE_LIMIT_WINDOW_MS } from "./ratelimit";
import { prisma } from "@/lib/prisma";

const queryRawMock = prisma.$queryRaw as unknown as jest.Mock;

describe("checkRateLimit", () => {
  beforeEach(() => {
    queryRawMock.mockReset();
  });

  // Invariant (CRITICAL): the limiter is FAIL-OPEN. If the DB is unreachable or
  // the query throws for any reason, it must return { allowed: true } so it can
  // never lock out legitimate users. This is the single most important guarantee
  // of this module — abuse mitigation must never become an availability hole.
  it("returns { allowed: true } when the DB query throws (fail-open)", async () => {
    queryRawMock.mockRejectedValueOnce(new Error("connection refused"));

    const result = await checkRateLimit("some-id", "poll", 30, RATE_LIMIT_WINDOW_MS);

    expect(result).toEqual({ allowed: true });
  });

  // Invariant: at or below the limit, the request is allowed (boundary = limit
  // itself is still allowed, since the check is count <= limit).
  it("allows when the returned count is within the limit", async () => {
    queryRawMock.mockResolvedValueOnce([{ count: 1 }]);
    await expect(
      checkRateLimit("id", "poll", 30, RATE_LIMIT_WINDOW_MS),
    ).resolves.toEqual({ allowed: true });

    queryRawMock.mockResolvedValueOnce([{ count: 30 }]);
    await expect(
      checkRateLimit("id", "poll", 30, RATE_LIMIT_WINDOW_MS),
    ).resolves.toEqual({ allowed: true });
  });

  // Invariant: once the count exceeds the limit, the request is denied. Combined
  // with the boundary test above this pins the comparison as count <= limit.
  it("denies when the returned count exceeds the limit", async () => {
    queryRawMock.mockResolvedValueOnce([{ count: 31 }]);

    const result = await checkRateLimit("id", "poll", 30, RATE_LIMIT_WINDOW_MS);

    expect(result).toEqual({ allowed: false });
  });

  // Invariant: a missing/empty result set is treated as count 0 → allowed,
  // rather than throwing on rows[0].count.
  it("allows when the query returns no rows (count defaults to 0)", async () => {
    queryRawMock.mockResolvedValueOnce([]);

    const result = await checkRateLimit("id", "join", 10, RATE_LIMIT_WINDOW_MS);

    expect(result).toEqual({ allowed: true });
  });

  // Invariant (CRITICAL): the raw caller id/token is NEVER persisted — only its
  // sha256 hex digest is. We assert the key bound into the parameterized query is
  // the 64-char hex digest of the input, and that the raw input does not appear.
  it("hashes the key with sha256 before it reaches the DB layer", async () => {
    queryRawMock.mockResolvedValueOnce([{ count: 1 }]);

    const rawId = "session-raw-id-1234";
    const expectedHash = createHash("sha256").update(rawId).digest("hex");

    await checkRateLimit(rawId, "poll", 30, RATE_LIMIT_WINDOW_MS);

    // prisma.$queryRaw is a tagged template: call args are
    // [templateStringsArray, ...interpolatedValues]. The first interpolated
    // value is the hashed key.
    const callArgs = queryRawMock.mock.calls[0];
    const interpolated = callArgs.slice(1);

    expect(interpolated).toContain(expectedHash);
    expect(expectedHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(expectedHash)).toBe(true);
    // The raw id must NOT be passed through anywhere in the interpolated values.
    expect(interpolated).not.toContain(rawId);
  });

  // Invariant: the exported config keeps the documented headroom for normal
  // clients (poll every 1500ms => ~6-7 polls per 10s window, well under 30).
  it("exposes a 10s window and per-route limits with headroom", () => {
    expect(RATE_LIMIT_WINDOW_MS).toBe(10_000);
    expect(RATE_LIMITS).toEqual({ poll: 30, signal: 60, join: 10 });
  });
});
