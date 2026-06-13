import { GET } from "../route";

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("GET /api/turn-credentials", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockClear();
    delete process.env.CLOUDFLARE_TURN_TOKEN_ID;
    delete process.env.CLOUDFLARE_TURN_API_TOKEN;
  });

  afterEach(() => {
    delete process.env.CLOUDFLARE_TURN_TOKEN_ID;
    delete process.env.CLOUDFLARE_TURN_API_TOKEN;
  });

  test("success: returns 200 with TURN credentials", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          iceServers: [
            { urls: ["stun:stun.l.cloudflare.com:3478"] },
            {
              urls: ["turn:turn.example.cloudflare.com:3478"],
              username: "cloudflare-user-1234",
              credential: "cloudflare-pass-5678",
            },
          ],
        },
      }),
    });

    const response = await GET();
    expect(response.status).toBe(200);

    const data = (await response.json()) as any;
    expect(data.urls[0]).toBe("turn:turn.example.cloudflare.com:3478");
    expect(data.username).toBe("cloudflare-user-1234");
    expect(data.credential).toBe("cloudflare-pass-5678");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringMatching(/api.cloudflare.com\/client\/v4\/accounts\/test-account-id\/rtc\/config/),
      expect.objectContaining({
        method: "POST",
      })
    );

    const callArg = mockFetch.mock.calls[0][1];
    expect(callArg.headers.Authorization).toMatch(/Bearer test-api-token/);
  });

  test("error: missing CLOUDFLARE_TURN_TOKEN_ID, returns 500", async () => {
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    const response = await GET();

    expect(response.status).toBe(500);
    const data = (await response.json()) as any;
    expect(data.error).toMatch(/not configured/i);
  });

  test("error: missing CLOUDFLARE_TURN_API_TOKEN, returns 500", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";

    const response = await GET();

    expect(response.status).toBe(500);
    const data = (await response.json()) as any;
    expect(data.error).toMatch(/not configured/i);
  });

  test("error: Cloudflare API returns non-OK status", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = (await response.json()) as any;
    expect(data.error).toMatch(/Failed to fetch/i);
  });

  test("error: Cloudflare API returns success=false", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: false,
        errors: [{ message: "Invalid request" }],
      }),
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = (await response.json()) as any;
    expect(data.error).toMatch(/Invalid TURN/i);
  });

  test("error: Cloudflare response missing result.iceServers", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
      }),
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = (await response.json()) as any;
    expect(data.error).toMatch(/Invalid TURN/i);
  });

  test("error: Cloudflare response has no TURN server (missing username/credential)", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          iceServers: [{ urls: ["stun:stun.l.cloudflare.com:3478"] }],
        },
      }),
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = (await response.json()) as any;
    expect(data.error).toMatch(/No TURN server/i);
  });

  test("error: Cloudflare response TURN server missing urls", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          iceServers: [
            { urls: ["stun:stun.l.cloudflare.com:3478"] },
            {
              username: "cloudflare-user",
              credential: "cloudflare-pass",
            },
          ],
        },
      }),
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = (await response.json()) as any;
    expect(data.error).toMatch(/No TURN server/i);
  });

  test("error: Cloudflare response TURN server has empty urls array", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          iceServers: [
            { urls: ["stun:stun.l.cloudflare.com:3478"] },
            {
              urls: [],
              username: "cloudflare-user",
              credential: "cloudflare-pass",
            },
          ],
        },
      }),
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = (await response.json()) as any;
    expect(data.error).toMatch(/No TURN server/i);
  });

  test("error: fetch throws exception", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const response = await GET();

    expect(response.status).toBe(500);
    const data = (await response.json()) as any;
    expect(data.error).toMatch(/Internal server error/i);
  });

  test("success: multiple TURN servers in response, picks first with credentials", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          iceServers: [
            { urls: ["stun:stun.l.cloudflare.com:3478"] },
            {
              urls: ["turn:turn1.example.com:3478"],
              username: "user1",
              credential: "pass1",
            },
            {
              urls: ["turn:turn2.example.com:3478"],
              username: "user2",
              credential: "pass2",
            },
          ],
        },
      }),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.urls).toEqual(["turn:turn1.example.com:3478"]);
    expect(data.username).toBe("user1");
    expect(data.credential).toBe("pass1");
  });

  test("success: response includes Cache-Control header", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "test-account-id";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          iceServers: [
            { urls: ["stun:stun.l.cloudflare.com:3478"] },
            {
              urls: ["turn:turn.example.com:3478"],
              username: "user",
              credential: "pass",
            },
          ],
        },
      }),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toMatch(/max-age=300/);
  });
});
