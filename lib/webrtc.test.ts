import { buildICEConfig, type TurnCredentialsResponse } from "./webrtc";

describe("buildICEConfig", () => {
  let originalFetch: typeof global.fetch;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    originalFetch = global.fetch;
    warnSpy = jest.spyOn(console, "warn").mockImplementation();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it("returns RTCConfiguration with both STUN and TURN servers on success", async () => {
    const mockResponse: TurnCredentialsResponse = {
      urls: ["turn:turn.example.com:3478"],
      username: "cloudflare-user-1234",
      credential: "cloudflare-pass-5678",
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(2);
    expect(config.iceServers![0]).toEqual({ urls: "stun:stun.l.google.com:19302" });
    expect(config.iceServers![1]).toEqual({
      urls: mockResponse.urls,
      username: mockResponse.username,
      credential: mockResponse.credential,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to STUN-only on fetch non-OK response (HTTP 500)", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(config.iceServers![0]).toEqual({ urls: "stun:stun.l.google.com:19302" });
    expect(warnSpy).toHaveBeenCalledWith("TURN fetch failed: HTTP 500");
  });

  it("falls back to STUN-only on fetch timeout (AbortError)", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    global.fetch = jest.fn().mockRejectedValueOnce(abortError);

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(config.iceServers![0]).toEqual({ urls: "stun:stun.l.google.com:19302" });
    expect(warnSpy).toHaveBeenCalledWith("TURN fetch timeout");
  });

  it("falls back to STUN-only on fetch network error", async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(
      new Error("Network error"),
    );

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(config.iceServers![0]).toEqual({ urls: "stun:stun.l.google.com:19302" });
    expect(warnSpy).toHaveBeenCalledWith("TURN fetch error: Network error");
  });

  it("falls back to STUN-only on response invalid JSON", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error("Invalid JSON");
      },
    });

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(config.iceServers![0]).toEqual({ urls: "stun:stun.l.google.com:19302" });
    expect(warnSpy).toHaveBeenCalledWith("TURN fetch error: Invalid JSON");
  });

  it("falls back to STUN-only on response missing urls field", async () => {
    const mockResponse = {
      username: "user",
      credential: "pass",
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(config.iceServers![0]).toEqual({ urls: "stun:stun.l.google.com:19302" });
    expect(warnSpy).toHaveBeenCalledWith("TURN: missing or empty urls");
  });

  it("falls back to STUN-only on response with empty urls array", async () => {
    const mockResponse: TurnCredentialsResponse = {
      urls: [],
      username: "user",
      credential: "pass",
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(config.iceServers![0]).toEqual({ urls: "stun:stun.l.google.com:19302" });
    expect(warnSpy).toHaveBeenCalledWith("TURN: missing or empty urls");
  });

  it("falls back to STUN-only on response missing username or credential", async () => {
    const mockResponse: TurnCredentialsResponse = {
      urls: ["turn:turn.example.com:3478"],
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(config.iceServers![0]).toEqual({ urls: "stun:stun.l.google.com:19302" });
    expect(warnSpy).toHaveBeenCalledWith("TURN: missing username or credential");
  });

  it("calls fetch with correct parameters", async () => {
    const mockResponse: TurnCredentialsResponse = {
      urls: ["turn:turn.example.com:3478"],
      username: "user",
      credential: "pass",
    };

    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    await buildICEConfig();

    expect(global.fetch).toHaveBeenCalledWith("/api/turn-credentials", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });
});
