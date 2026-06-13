// Mock Prisma before importing the route. poll verifies the capability token,
// heartbeats, reaps, reads peers, and drains the mailbox — so we mock every
// prisma call it touches. Auth happens BEFORE any read/heartbeat/drain, which is
// the behavior these tests pin down.
jest.mock("@/lib/prisma", () => ({
  prisma: {
    presence: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    signal: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    rateLimit: {
      deleteMany: jest.fn(),
    },
  },
}));

// Keep rate-limiting deterministic and out of the way: always allow. (The
// limiter's own fail-open/threshold behavior is covered in lib/ratelimit.test.)
jest.mock("@/lib/ratelimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
  RATE_LIMITS: { poll: 30, signal: 60, join: 10 },
  RATE_LIMIT_WINDOW_MS: 10_000,
}));

import type { NextRequest } from "next/server";
import { GET } from "../route";
import { prisma } from "@/lib/prisma";

const ID = "session-abcdef12";
const TOKEN = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

const findUnique = prisma.presence.findUnique as jest.Mock;
const updateMany = prisma.presence.updateMany as jest.Mock;
const presenceDeleteMany = prisma.presence.deleteMany as jest.Mock;
const findManyPeers = prisma.presence.findMany as jest.Mock;
const signalFindMany = prisma.signal.findMany as jest.Mock;
const signalDeleteMany = prisma.signal.deleteMany as jest.Mock;
const rateLimitDeleteMany = prisma.rateLimit.deleteMany as jest.Mock;

function makeRequest(id?: string, token?: string): NextRequest {
  const url = new URL("https://test.local/api/poll");
  if (id !== undefined) url.searchParams.set("id", id);
  if (token !== undefined) url.searchParams.set("token", token);
  return { nextUrl: url } as unknown as NextRequest;
}

describe("GET /api/poll", () => {
  beforeEach(() => {
    findUnique.mockReset();
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    presenceDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    findManyPeers.mockReset().mockResolvedValue([]);
    signalFindMany.mockReset().mockResolvedValue([]);
    signalDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    rateLimitDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  });

  // Invariant: a malformed id is rejected at the boundary (400) before any DB
  // work — no presence lookup, no heartbeat.
  it("returns 400 for an invalid id and does no DB work", async () => {
    const res = await GET(makeRequest("bad", TOKEN));

    expect(res.status).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  // Invariant: a missing token is unauthenticated → 401, no peer data leaked,
  // and the mailbox is NOT drained (no signal read/delete). This protects
  // against an unauthenticated caller draining a victim's mailbox by id alone.
  it("returns 401 when no token is provided and does not drain the mailbox", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });

    const res = await GET(makeRequest(ID));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.peers).toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
    expect(signalFindMany).not.toHaveBeenCalled();
    expect(signalDeleteMany).not.toHaveBeenCalled();
  });

  // Invariant: a wrong token is rejected the same way as a missing one.
  it("returns 401 for a wrong token and does not drain the mailbox", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });

    const res = await GET(makeRequest(ID, "ffffffff-ffff-ffff-ffff-ffffffffffff"));

    expect(res.status).toBe(401);
    expect(signalFindMany).not.toHaveBeenCalled();
    expect(signalDeleteMany).not.toHaveBeenCalled();
  });

  // Invariant: the legitimate owner gets 200 with peers, the heartbeat runs, and
  // the mailbox is drained (read then delete the same ids).
  it("returns 200 with peers and drains the mailbox for the valid owner", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });
    findManyPeers.mockResolvedValue([
      { id: "peer-12345678", lat: 1, lng: 2, busy: false },
    ]);
    signalFindMany.mockResolvedValue([
      {
        id: "sig-1",
        fromId: "peer-12345678",
        toId: ID,
        type: "request",
        payload: null,
        createdAt: new Date("2026-06-13T00:00:00.000Z"),
      },
    ]);

    const res = await GET(makeRequest(ID, TOKEN));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.peers).toEqual([
      { id: "peer-12345678", lat: 1, lng: 2, busy: false },
    ]);
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({ id: "sig-1", type: "request" });

    // Heartbeat ran for the caller only.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID } }),
    );
    // Mailbox drained: the read ids were deleted.
    expect(signalDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["sig-1"] } } }),
    );
  });

  // Invariant: the peer list NEVER includes the token (it must not be selected).
  // We assert the findMany select omits token, which is what keeps the secret off
  // the wire.
  it("never selects the token field when reading peers", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });

    await GET(makeRequest(ID, TOKEN));

    const peersCall = findManyPeers.mock.calls[0][0];
    expect(peersCall.select).toEqual({
      id: true,
      lat: true,
      lng: true,
      busy: true,
    });
    expect(peersCall.select.token).toBeUndefined();
  });
});
