import { GET } from "../route";

describe("GET /api/turn-credentials", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("returns 200 with TURN credentials on success", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "account-123";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "token-456";

    const mockCloudflareResponse = {
      success: true,
      result: {
        iceServers: [
          {
            urls: ["turn:turn.cloudflare.com:3478"],
            username: "cloudflare-user-1234",
            credential: "cloudflare-pass-5678",
          },
        ],
      },
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockCloudflareResponse,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      urls: ["turn:turn.cloudflare.com:3478"],
      username: "cloudflare-user-1234",
      credential: "cloudflare-pass-5678",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=300");
  });

  it("returns 500 when CLOUDFLARE_TURN_TOKEN_ID is missing", async () => {
    delete process.env.CLOUDFLARE_TURN_TOKEN_ID;
    process.env.CLOUDFLARE_TURN_API_TOKEN = "token-456";

    const response = await GET();

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  it("returns 500 when CLOUDFLARE_TURN_API_TOKEN is missing", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "account-123";
    delete process.env.CLOUDFLARE_TURN_API_TOKEN;

    const response = await GET();

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  it("returns 500 when Cloudflare returns non-OK status", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "account-123";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "token-456";

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  it("returns 500 when Cloudflare returns success: false", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "account-123";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "token-456";

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, errors: [{ message: "Invalid" }] }),
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  it("returns 500 when Cloudflare response missing iceServers", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "account-123";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "token-456";

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, result: {} }),
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  it("returns 500 when no TURN server entry (missing username/credential)", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "account-123";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "token-456";

    const mockCloudflareResponse = {
      success: true,
      result: {
        iceServers: [
          {
            urls: ["stun:stun.cloudflare.com:3478"],
            // no username/credential for STUN
          },
        ],
      },
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockCloudflareResponse,
    });

    const response = await GET();

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  it("returns 500 when network fetch throws", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "account-123";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "token-456";

    global.fetch = jest.fn().mockRejectedValueOnce(new Error("Network error"));

    const response = await GET();

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBeTruthy();
  });

  it("calls Cloudflare API with correct parameters", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "account-123";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "token-456";

    const mockCloudflareResponse = {
      success: true,
      result: {
        iceServers: [
          {
            urls: ["turn:turn.cloudflare.com:3478"],
            username: "user",
            credential: "pass",
          },
        ],
      },
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockCloudflareResponse,
    });

    await GET();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-123/rtc/config",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-456",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("includes AbortSignal timeout in fetch call", async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = "account-123";
    process.env.CLOUDFLARE_TURN_API_TOKEN = "token-456";

    const mockCloudflareResponse = {
      success: true,
      result: {
        iceServers: [
          {
            urls: ["turn:turn.cloudflare.com:3478"],
            username: "user",
            credential: "pass",
          },
        ],
      },
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockCloudflareResponse,
    });

    await GET();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
