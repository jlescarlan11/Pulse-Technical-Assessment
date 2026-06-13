// Mock Prisma before importing the route. join validates input, rate-limits by
// id (no token exists yet), applies the privacy offset, and upserts the presence
// row with a freshly-minted capability token. These tests pin down the security-
// relevant invariants: a token is minted and returned exactly once, it rotates
// on every join, raw coordinates are never stored, and bad input / rate limits
// short-circuit before any DB write.
jest.mock("@/lib/prisma", () => ({
  prisma: {
    presence: {
      upsert: jest.fn(),
    },
  },
}));

// Keep rate-limiting deterministic and out of the way: always allow by default.
// (The limiter's own fail-open/threshold behavior is covered in
// lib/ratelimit.test.)
jest.mock("@/lib/ratelimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
  RATE_LIMITS: { poll: 30, signal: 60, join: 10 },
  RATE_LIMIT_WINDOW_MS: 10_000,
}));

import type { NextRequest } from "next/server";
import { POST } from "../route";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/ratelimit";

const upsert = prisma.presence.upsert as jest.Mock;
const rateLimit = checkRateLimit as jest.Mock;

const ID = "session-abcdef12";
const RAW_LAT = 14.6;
const RAW_LNG = 121.0;

function makeRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/join", () => {
  beforeEach(() => {
    upsert.mockReset().mockResolvedValue({});
    rateLimit.mockReset().mockResolvedValue({ allowed: true });
  });

  // Invariant: a valid join mints a token and returns it (exactly once, in the
  // response body) — this is the root of the whole capability-token auth model.
  it("mints a token and returns it for a valid join", async () => {
    const res = await POST(makeRequest({ id: ID, lat: RAW_LAT, lng: RAW_LNG }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  // Invariant: raw coordinates are never persisted — the stored coords are the
  // 1–3 km privacy offset, and the same fresh token is written on both the
  // create and update branches of the upsert.
  it("stores privacy-offset coordinates, never the raw ones", async () => {
    await POST(makeRequest({ id: ID, lat: RAW_LAT, lng: RAW_LNG }));

    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ id: ID });
    expect(arg.create.lat).not.toBe(RAW_LAT);
    expect(arg.create.lng).not.toBe(RAW_LNG);
    expect(arg.create.token).toBe(arg.update.token);
    expect(typeof arg.create.token).toBe("string");
  });

  // Invariant: rotate-on-join — every join mints a brand-new token so the latest
  // join owns the session and a previously-leaked token stops working.
  it("mints a fresh token on every join", async () => {
    const res1 = await POST(makeRequest({ id: ID, lat: RAW_LAT, lng: RAW_LNG }));
    const res2 = await POST(makeRequest({ id: ID, lat: RAW_LAT, lng: RAW_LNG }));

    const t1 = (await res1.json()).token;
    const t2 = (await res2.json()).token;
    expect(t1).not.toBe(t2);
  });

  // Invariant: a malformed id is rejected at the boundary before any DB write.
  it("returns 400 for an invalid id and does not upsert", async () => {
    const res = await POST(makeRequest({ id: "bad", lat: RAW_LAT, lng: RAW_LNG }));

    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  // Invariant: out-of-range coordinates are rejected before any DB write.
  it("returns 400 for invalid coordinates and does not upsert", async () => {
    const res = await POST(makeRequest({ id: ID, lat: 999, lng: RAW_LNG }));

    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  // Invariant: a rate-limited join is short-circuited with 429 before any DB
  // write (join flood protection).
  it("returns 429 when rate limited and does not upsert", async () => {
    rateLimit.mockResolvedValue({ allowed: false });

    const res = await POST(makeRequest({ id: ID, lat: RAW_LAT, lng: RAW_LNG }));

    expect(res.status).toBe(429);
    expect(upsert).not.toHaveBeenCalled();
  });

  // Invariant: an unparseable body is rejected, not crashed on.
  it("returns 400 for an unparseable body and does not upsert", async () => {
    const bad = {
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as NextRequest;

    const res = await POST(bad);

    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });
});
