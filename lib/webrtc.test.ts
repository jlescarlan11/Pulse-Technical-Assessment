import { buildICEConfig, PeerSession } from "./webrtc";

// Mock for global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("buildICEConfig()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockClear();
  });

  test("success path: returns config with STUN and TURN servers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        urls: ["turn:turn.example.com:3478"],
        username: "testuser",
        credential: "testpass",
      }),
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(2);
    expect(config.iceServers![0].urls).toBe("stun:stun.l.google.com:19302");

    const turnServer = config.iceServers![1];
    expect(turnServer.urls).toEqual(["turn:turn.example.com:3478"]);
    expect(turnServer.username).toBe("testuser");
    expect(turnServer.credential).toBe("testpass");
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });

  test("failure: fetch returns 500 error, falls back to STUN-only", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(config.iceServers![0].urls).toBe("stun:stun.l.google.com:19302");
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/status 500/)
    );

    consoleWarnSpy.mockRestore();
  });

  test("failure: fetch timeout (AbortSignal), falls back to STUN-only", async () => {
    const abortError = new Error("The operation was aborted");
    (abortError as any).name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortError);

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

    consoleWarnSpy.mockRestore();
  });

  test("failure: response has invalid JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

    consoleWarnSpy.mockRestore();
  });

  test("failure: response missing urls field", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        username: "testuser",
        credential: "testpass",
      }),
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/missing or invalid/i)
    );

    consoleWarnSpy.mockRestore();
  });

  test("failure: response has empty urls array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        urls: [],
        username: "testuser",
        credential: "testpass",
      }),
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

    consoleWarnSpy.mockRestore();
  });

  test("failure: response missing username credential", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        urls: ["turn:turn.example.com:3478"],
      }),
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config.iceServers!).toHaveLength(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/username or credential/i)
    );

    consoleWarnSpy.mockRestore();
  });

  test("never throws, always returns valid RTCConfiguration", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config).toBeDefined();
    expect(config.iceServers).toBeDefined();
    expect(config.iceServers!).toHaveLength(1);

    consoleWarnSpy.mockRestore();
  });

  test("verify fetch is called with correct parameters", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        urls: ["turn:turn.example.com:3478"],
        username: "testuser",
        credential: "testpass",
      }),
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    await buildICEConfig();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/turn-credentials",
      expect.objectContaining({
        method: "GET",
        headers: { "Content-Type": "application/json" },
      })
    );

    consoleWarnSpy.mockRestore();
  });
});

describe("PeerSession constructor", () => {
  let mockDataChannel: any;
  let mockPeerConnection: any;
  let originalRTC: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockDataChannel = {
      readyState: "connecting",
      onopen: null,
      onmessage: null,
      send: jest.fn(),
      close: jest.fn(),
    };

    mockPeerConnection = {
      onicecandidate: null,
      onnegotiationneeded: null,
      ontrack: null,
      onconnectionstatechange: null,
      ondatachannel: null,
      createDataChannel: jest.fn(() => mockDataChannel),
      close: jest.fn(),
    };

    originalRTC = (global as any).RTCPeerConnection;
    (global as any).RTCPeerConnection = jest.fn(() => mockPeerConnection);
  });

  afterEach(() => {
    (global as any).RTCPeerConnection = originalRTC;
  });

  test("accepts iceConfig parameter and passes to RTCPeerConnection", () => {
    const customConfig: RTCConfiguration = {
      iceServers: [
        { urls: "stun:custom.com:19302" },
        {
          urls: ["turn:custom.com:3478"],
          username: "user",
          credential: "pass",
        },
      ],
    };

    const callbacks = {
      onSignal: jest.fn(),
      onChat: jest.fn(),
      onControl: jest.fn(),
      onRemoteStream: jest.fn(),
      onConnectionState: jest.fn(),
      onChannelOpen: jest.fn(),
    };

    const ps = new PeerSession(true, callbacks, customConfig);

    expect((global as any).RTCPeerConnection).toHaveBeenCalledTimes(1);
    expect((global as any).RTCPeerConnection).toHaveBeenCalledWith(
      customConfig
    );
  });

  test("backward compatible: works with default STUN config when iceConfig not provided", () => {
    const callbacks = {
      onSignal: jest.fn(),
      onChat: jest.fn(),
      onControl: jest.fn(),
      onRemoteStream: jest.fn(),
      onConnectionState: jest.fn(),
      onChannelOpen: jest.fn(),
    };

    const ps = new PeerSession(true, callbacks);

    expect((global as any).RTCPeerConnection).toHaveBeenCalledTimes(1);
    const callArg = ((global as any).RTCPeerConnection as jest.Mock).mock
      .calls[0][0];
    expect(callArg).toBeDefined();
    expect(callArg.iceServers).toHaveLength(1);
    expect(callArg.iceServers![0].urls).toBe("stun:stun.l.google.com:19302");
  });

  test("creates data channel when initiator is true", () => {
    const callbacks = {
      onSignal: jest.fn(),
      onChat: jest.fn(),
      onControl: jest.fn(),
      onRemoteStream: jest.fn(),
      onConnectionState: jest.fn(),
      onChannelOpen: jest.fn(),
    };

    const ps = new PeerSession(true, callbacks);

    expect(mockPeerConnection.createDataChannel).toHaveBeenCalledTimes(1);
    expect(mockPeerConnection.createDataChannel).toHaveBeenCalledWith("chat");
  });

  test("does not create data channel when initiator is false", () => {
    const callbacks = {
      onSignal: jest.fn(),
      onChat: jest.fn(),
      onControl: jest.fn(),
      onRemoteStream: jest.fn(),
      onConnectionState: jest.fn(),
      onChannelOpen: jest.fn(),
    };

    const ps = new PeerSession(false, callbacks);

    expect(mockPeerConnection.createDataChannel).not.toHaveBeenCalled();
  });
});
