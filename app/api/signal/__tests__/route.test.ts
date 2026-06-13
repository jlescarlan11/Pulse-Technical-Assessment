// Mock Prisma + the rate limiter before importing the route. signal verifies the
// token against fromId's session BEFORE touching busy flags or the mailbox —
// this is what blocks fromId spoofing. These tests pin that contract.
jest.mock("@/lib/prisma", () => ({
  prisma: {
    presence: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    signal: {
      create: jest.fn(),
    },
  },
}));

jest.mock("@/lib/ratelimit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true }),
  RATE_LIMITS: { poll: 30, signal: 60, join: 10 },
  RATE_LIMIT_WINDOW_MS: 10_000,
}));

import { POST } from "../route";
import { prisma } from "@/lib/prisma";
import type { NextRequest } from "next/server";

const FROM = "from-abcdef12";
const TO = "to-abcdef1234";
const TOKEN = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

const findUnique = prisma.presence.findUnique as jest.Mock;
const updateMany = prisma.presence.updateMany as jest.Mock;
const signalCreate = prisma.signal.create as jest.Mock;

function makeRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/signal", () => {
  beforeEach(() => {
    findUnique.mockReset();
    updateMany.mockReset().mockResolvedValue({ count: 2 });
    signalCreate.mockReset().mockResolvedValue({ id: "sig-new" });
  });

  // Invariant: invalid ids rejected at the boundary, no DB work.
  it("returns 400 for an invalid id and does no DB work", async () => {
    const res = await POST(
      makeRequest({ fromId: "bad", toId: TO, type: "offer", token: TOKEN }),
    );

    expect(res.status).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
    expect(signalCreate).not.toHaveBeenCalled();
  });

  // Invariant: an unknown signal type is rejected before any DB work.
  it("returns 400 for an invalid signal type", async () => {
    const res = await POST(
      makeRequest({ fromId: FROM, toId: TO, type: "hack", token: TOKEN }),
    );

    expect(res.status).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
    expect(signalCreate).not.toHaveBeenCalled();
  });

  // Invariant: an oversized payload is rejected before any DB work — bounds the
  // mailbox row size.
  it("returns 400 for an oversized payload", async () => {
    const res = await POST(
      makeRequest({
        fromId: FROM,
        toId: TO,
        type: "offer",
        token: TOKEN,
        payload: "x".repeat(64 * 1024 + 1),
      }),
    );

    expect(res.status).toBe(400);
    expect(signalCreate).not.toHaveBeenCalled();
  });

  // Invariant (CRITICAL): a token that does not match fromId's session is
  // unauthorized → 401, NO signal created, and busy flags NOT changed. This is
  // the anti-spoofing guarantee: an attacker cannot inject signals as another
  // user or flip a victim's busy flag.
  it("returns 401 when the token does not match fromId; no signal, no busy change", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });

    const res = await POST(
      makeRequest({
        fromId: FROM,
        toId: TO,
        type: "accept",
        token: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      }),
    );

    expect(res.status).toBe(401);
    expect(signalCreate).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  // Invariant: a missing token is rejected the same way.
  it("returns 401 when no token is provided; no signal, no busy change", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });

    const res = await POST(
      makeRequest({ fromId: FROM, toId: TO, type: "accept" }),
    );

    expect(res.status).toBe(401);
    expect(signalCreate).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  // Invariant: the legitimate sender's signal is created.
  it("creates the signal for the authenticated sender", async () => {
    // First findUnique (sender auth) returns the matching token.
    findUnique.mockResolvedValue({ token: TOKEN });

    const res = await POST(
      makeRequest({
        fromId: FROM,
        toId: TO,
        type: "offer",
        token: TOKEN,
        payload: "sdp-here",
      }),
    );

    expect(res.status).toBe(200);
    expect(signalCreate).toHaveBeenCalledWith({
      data: { fromId: FROM, toId: TO, type: "offer", payload: "sdp-here" },
    });
  });

  // Invariant: token verification happens against fromId's row specifically —
  // not toId's — so a sender proves ownership of the from side.
  it("verifies the token against the fromId presence row", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });

    await POST(
      makeRequest({ fromId: FROM, toId: TO, type: "offer", token: TOKEN }),
    );

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FROM } }),
    );
  });
});
