// Mock the Prisma client before importing the route. The route now gates TURN
// minting behind a valid session capability token, so it looks up Presence by
// id and verifies the token before ever calling Cloudflare.
jest.mock("@/lib/prisma", () => ({
  prisma: {
    presence: {
      findUnique: jest.fn(),
    },
  },
}));

import type { NextRequest } from "next/server";
import { GET } from "../route";
import { prisma } from "@/lib/prisma";

// The route calls the Cloudflare Realtime TURN API:
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/<keyId>/credentials/generate-ice-servers
// with body { ttl: 600 }. Cloudflare responds (HTTP 201) with a BARE object:
//   { iceServers: CloudflareIceServer[] }  -- no success/result wrapper.
// The route picks the first entry that has both username and credential and
// returns { urls, username, credential } with Cache-Control: private, max-age=300.

const TURN_KEY_ID = "key-abc-123";
const API_TOKEN = "token-456";
const TURN_CRED_TTL = 600;

// A valid session id + its capability token. The route reads these from the
// query string (?id=&token=) and verifies the token against the Presence row.
const SESSION_ID = "session-1234";
const SESSION_TOKEN = "valid-session-token";

const findUniqueMock = prisma.presence.findUnique as jest.Mock;

// Build a minimal NextRequest-like object exposing nextUrl.searchParams, which
// is all the route reads off the request.
function makeRequest(id?: string, token?: string): NextRequest {
  const url = new URL("https://test.local/api/turn-credentials");
  if (id !== undefined) url.searchParams.set("id", id);
  if (token !== undefined) url.searchParams.set("token", token);
  return { nextUrl: url } as unknown as NextRequest;
}

// A request carrying the valid session credentials (the common case).
function authedRequest(): NextRequest {
  return makeRequest(SESSION_ID, SESSION_TOKEN);
}

// Mirrors a realistic Cloudflare success body: first entry is STUN-only (no
// creds), second carries the TURN credentials. The selection logic must skip
// the STUN entry and pick the TURN one.
const cloudflareSuccessBody = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "hex-username-abc",
      credential: "hex-credential-xyz",
    },
  ],
};

const turnUrls = cloudflareSuccessBody.iceServers[1].urls;

describe("GET /api/turn-credentials", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    // The route logs via console.error on failure branches; silence it so the
    // suite output stays clean while still allowing assertions on behavior.
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    // Default: the session exists and its token matches, so auth passes and the
    // tests can exercise the Cloudflare-facing behavior. Individual tests can
    // override this to exercise the 401 path.
    findUniqueMock.mockReset();
    findUniqueMock.mockResolvedValue({ token: SESSION_TOKEN });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    errorSpy.mockRestore();
  });

  // Invariant: a healthy Cloudflare response yields the client contract
  // { urls, username, credential } at 200 with a private 5-minute cache.
  it("returns 200 with the TURN credentials on success", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => cloudflareSuccessBody,
    });

    const response = await GET(authedRequest());

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      urls: turnUrls,
      username: "hex-username-abc",
      credential: "hex-credential-xyz",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=300");
  });

  // Invariant: misconfiguration (no key id) fails closed with 500 and never
  // calls Cloudflare.
  it("returns 500 when CLOUDFLARE_TURN_TOKEN_ID is missing", async () => {
    delete process.env.CLOUDFLARE_TURN_TOKEN_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const response = await GET(authedRequest());

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Invariant: misconfiguration (no API token) fails closed with 500 and never
  // calls Cloudflare.
  it("returns 500 when CLOUDFLARE_TURN_API_TOKEN is missing", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    delete process.env.CLOUDFLARE_TURN_API_TOKEN;

    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const response = await GET(authedRequest());

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Invariant: an upstream auth/validation failure (non-ok HTTP) is not leaked
  // to the client as a partial/empty success; it surfaces as 500.
  it("returns 500 when Cloudflare returns a non-OK status", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    const response = await GET(authedRequest());

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  it("returns 500 when Cloudflare returns a 400 error", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });

    const response = await GET(authedRequest());

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  // Invariant: a 2xx body that doesn't match the expected shape (iceServers
  // missing) is rejected rather than passed through.
  it("returns 500 when iceServers is missing from the response", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({}),
    });

    const response = await GET(authedRequest());

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  it("returns 500 when iceServers is not an array", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ iceServers: { username: "x", credential: "y" } }),
    });

    const response = await GET(authedRequest());

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  // Invariant: a structurally valid response that contains only STUN entries
  // (no usable TURN credentials) is a failure, not a silent empty success.
  it("returns 500 when no entry has username and credential (STUN-only)", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478"] },
          { urls: ["stun:stun.cloudflare.com:53"] },
        ],
      }),
    });

    const response = await GET(authedRequest());

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  // Invariant: a transport-level failure (thrown fetch) is contained and
  // returned as 500 rather than crashing the route.
  it("returns 500 when the network fetch throws", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    global.fetch = jest.fn().mockRejectedValueOnce(new Error("Network error"));

    const response = await GET(authedRequest());

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  // Invariant: the route calls the Cloudflare Realtime TURN endpoint correctly
  // -- right URL (keyed by the token id), POST, bearer auth, and a short
  // { ttl } (10 min) so leaked creds expire quickly.
  it("calls the Cloudflare Realtime TURN API with correct URL, method, auth, and body", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    const fetchMock = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => cloudflareSuccessBody,
    });
    global.fetch = fetchMock;

    await GET(authedRequest());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchMock.mock.calls[0];

    expect(calledUrl).toBe(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
    );
    expect(calledOptions).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ ttl: TURN_CRED_TTL }),
      }),
    );
  });

  it("includes an AbortSignal timeout in the fetch call", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => cloudflareSuccessBody,
    });

    await GET(authedRequest());

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  // Invariant: a missing/invalid session token fails closed with 401 and never
  // calls Cloudflare — credentials are gated behind proof of session ownership.
  it("returns 401 and does not call Cloudflare when the token is wrong", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;
    findUniqueMock.mockResolvedValue({ token: SESSION_TOKEN });

    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const response = await GET(makeRequest(SESSION_ID, "wrong-token"));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the session does not exist", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;
    findUniqueMock.mockResolvedValue(null);

    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const response = await GET(makeRequest(SESSION_ID, SESSION_TOKEN));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Invariant: a malformed id is rejected at the boundary (400) before any DB
  // lookup or Cloudflare call.
  it("returns 400 when the id is invalid", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = TURN_KEY_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = API_TOKEN;

    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const response = await GET(makeRequest("short", SESSION_TOKEN));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});
