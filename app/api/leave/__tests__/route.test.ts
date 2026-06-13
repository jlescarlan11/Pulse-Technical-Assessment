// Mock Prisma before importing the route. leave verifies the token from the body
// before deleting anything — these tests pin that the delete never runs for an
// unauthenticated caller.
jest.mock("@/lib/prisma", () => ({
  prisma: {
    presence: {
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
    signal: {
      deleteMany: jest.fn(),
    },
  },
}));

import type { NextRequest } from "next/server";
import { POST } from "../route";
import { prisma } from "@/lib/prisma";

const ID = "session-abcdef12";
const TOKEN = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

const findUnique = prisma.presence.findUnique as jest.Mock;
const presenceDeleteMany = prisma.presence.deleteMany as jest.Mock;
const signalDeleteMany = prisma.signal.deleteMany as jest.Mock;

// leave reads request.text() (sendBeacon-friendly), so the mock exposes text().
function makeRequest(body: unknown): NextRequest {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { text: async () => text } as unknown as NextRequest;
}

describe("POST /api/leave", () => {
  beforeEach(() => {
    findUnique.mockReset();
    presenceDeleteMany.mockReset().mockResolvedValue({ count: 1 });
    signalDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  });

  // Invariant: invalid id rejected at the boundary, no DB work.
  it("returns 400 for an invalid id and does no DB work", async () => {
    const res = await POST(makeRequest({ id: "bad", token: TOKEN }));

    expect(res.status).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
    expect(presenceDeleteMany).not.toHaveBeenCalled();
  });

  // Invariant: a missing token can never delete a session. Without the token
  // gate, anyone could evict any user by knowing their id.
  it("returns 401 when no token is provided and deletes nothing", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });

    const res = await POST(makeRequest({ id: ID }));

    expect(res.status).toBe(401);
    expect(presenceDeleteMany).not.toHaveBeenCalled();
    expect(signalDeleteMany).not.toHaveBeenCalled();
  });

  // Invariant: a wrong token can never delete a session.
  it("returns 401 for a wrong token and deletes nothing", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });

    const res = await POST(
      makeRequest({ id: ID, token: "ffffffff-ffff-ffff-ffff-ffffffffffff" }),
    );

    expect(res.status).toBe(401);
    expect(presenceDeleteMany).not.toHaveBeenCalled();
    expect(signalDeleteMany).not.toHaveBeenCalled();
  });

  // Invariant: the legitimate owner's leave deletes both the presence row and
  // its pending signals.
  it("deletes presence and signals for the valid owner", async () => {
    findUnique.mockResolvedValue({ token: TOKEN });

    const res = await POST(makeRequest({ id: ID, token: TOKEN }));

    expect(res.status).toBe(200);
    expect(presenceDeleteMany).toHaveBeenCalledWith({ where: { id: ID } });
    expect(signalDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ toId: ID }, { fromId: ID }] },
      }),
    );
  });

  // Invariant: a non-JSON / empty beacon body is treated as a missing id (400),
  // never a crash.
  it("returns 400 for an unparseable body", async () => {
    const res = await POST(makeRequest("not json {{{"));

    expect(res.status).toBe(400);
    expect(presenceDeleteMany).not.toHaveBeenCalled();
  });
});
