import { buildICEConfig, PeerSession } from "../lib/webrtc";

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("TURN Credentials Integration", () => {
  let mockPeerConnection: any;
  let originalRTC: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockClear();

    mockPeerConnection = {
      onicecandidate: null,
      onnegotiationneeded: null,
      ontrack: null,
      onconnectionstatechange: null,
      ondatachannel: null,
      createDataChannel: jest.fn(),
      close: jest.fn(),
    };

    originalRTC = (global as any).RTCPeerConnection;
    (global as any).RTCPeerConnection = jest.fn(() => mockPeerConnection);
  });

  afterEach(() => {
    (global as any).RTCPeerConnection = originalRTC;
  });

  test("buildICEConfig integration: fetches and returns TURN-enabled config", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        urls: ["turn:turn.example.com:3478"],
        username: "integrationuser",
        credential: "integrationpass",
      }),
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config.iceServers).toBeDefined();
    expect(config.iceServers).toHaveLength(2);

    const stunServer = config.iceServers![0];
    expect(stunServer.urls).toBe("stun:stun.l.google.com:19302");

    const turnServer = config.iceServers![1];
    expect(turnServer.urls).toEqual(["turn:turn.example.com:3478"]);
    expect(turnServer.username).toBe("integrationuser");
    expect(turnServer.credential).toBe("integrationpass");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/turn-credentials",
      expect.any(Object)
    );

    consoleWarnSpy.mockRestore();
  });

  test("PeerSession creation with buildICEConfig result", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        urls: ["turn:turn.example.com:3478"],
        username: "integrationuser",
        credential: "integrationpass",
      }),
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const iceConfig = await buildICEConfig();

    const mockDataChannel = {
      readyState: "connecting",
      onopen: null,
      onmessage: null,
      send: jest.fn(),
      close: jest.fn(),
    };

    mockPeerConnection.createDataChannel.mockReturnValue(mockDataChannel);

    const callbacks = {
      onSignal: jest.fn(),
      onChat: jest.fn(),
      onControl: jest.fn(),
      onRemoteStream: jest.fn(),
      onConnectionState: jest.fn(),
      onChannelOpen: jest.fn(),
    };

    const ps = new PeerSession(true, callbacks, iceConfig);

    const rtcCall = ((global as any).RTCPeerConnection as jest.Mock).mock
      .calls[0];
    expect(rtcCall[0]).toEqual(iceConfig);
    expect(rtcCall[0].iceServers).toHaveLength(2);

    consoleWarnSpy.mockRestore();
  });

  test("error scenario: buildICEConfig fails, PeerSession still created with fallback", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const iceConfig = await buildICEConfig();

    expect(iceConfig.iceServers).toHaveLength(1);

    const mockDataChannel = {
      readyState: "connecting",
      onopen: null,
      onmessage: null,
      send: jest.fn(),
      close: jest.fn(),
    };

    mockPeerConnection.createDataChannel.mockReturnValue(mockDataChannel);

    const callbacks = {
      onSignal: jest.fn(),
      onChat: jest.fn(),
      onControl: jest.fn(),
      onRemoteStream: jest.fn(),
      onConnectionState: jest.fn(),
      onChannelOpen: jest.fn(),
    };

    const ps = new PeerSession(true, callbacks, iceConfig);

    expect(ps).toBeDefined();

    const rtcCall = ((global as any).RTCPeerConnection as jest.Mock).mock
      .calls[0];
    expect(rtcCall[0]).toEqual(iceConfig);

    consoleWarnSpy.mockRestore();
  });

  test("multiple TURN servers in response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        urls: ["turn:primary.example.com:3478", "turn:backup.example.com:3478"],
        username: "multiuser",
        credential: "multipass",
      }),
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    const turnServer = config.iceServers![1];
    expect(turnServer.urls).toEqual([
      "turn:primary.example.com:3478",
      "turn:backup.example.com:3478",
    ]);

    consoleWarnSpy.mockRestore();
  });

  test("fetch timeout handling during integration", async () => {
    const abortError = new Error("The operation was aborted");
    mockFetch.mockRejectedValueOnce(abortError);

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

    const config = await buildICEConfig();

    expect(config.iceServers).toHaveLength(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

    consoleWarnSpy.mockRestore();
  });
});
