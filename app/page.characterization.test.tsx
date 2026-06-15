/**
 * @jest-environment jsdom
 *
 * R-0 — Characterization (regression) test for the Home god component.
 *
 * Stakeholder-mandated safety net: written against the CURRENT behaviour so the
 * upcoming state-machine extractions (R-4 Conn reducer, R-5 VideoState reducer +
 * useReciprocalVideo) can be verified to PRESERVE it. It pins the two
 * load-bearing behaviours that have no other end-to-end coverage:
 *
 *   1. The connection lifecycle: gate → live → requesting → connecting →
 *      connected (ChatPanel mounts only on a fully-open channel).
 *   2. The privacy-critical reciprocal-video gate: the outgoing video track is
 *      held OFF (fail-closed) until the peer proves presence, enabled once
 *      mutually present, and cut instantly the moment the peer steps away.
 *
 * The child components, the coordination API, and the WebRTC PeerSession are
 * mocked to lightweight doubles so the test exercises Home's orchestration, not
 * mapbox/getUserMedia/RTCPeerConnection. Assertions are on observable text and
 * on the gate primitive (setOutgoingVideoEnabled) — not on internals.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

// ── Mutable poll feed: the poll() mock reads these each tick. ──
let pollPeers: Array<{ id: string; lat: number; lng: number; busy: boolean }> = [];
let pollSignals: Array<Record<string, unknown>> = [];

// ── Captured WebRTC seam. ──
type PeerCb = {
  onChannelOpen: () => void;
  onControl: (c: string) => void;
  onRemoteStream: (s: unknown) => void;
  onConnectionState: (s: string) => void;
  onChat: (t: string) => void;
  onDelivered: (id: number) => void;
  onTyping: (on: boolean) => void;
  onSignal: (t: string, p: string) => void;
};
let peerCb: PeerCb | null = null;
let peerInstance: {
  setOutgoingVideoEnabled: jest.Mock;
  startVideo: jest.Mock;
  [k: string]: unknown;
} | null = null;

jest.mock("@/lib/api", () => ({
  __esModule: true,
  join: jest.fn(async () => ({ ok: true, token: "tok" })),
  poll: jest.fn(async () => ({ peers: pollPeers, signals: pollSignals })),
  sendSignal: jest.fn(async () => undefined),
  leave: jest.fn(),
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

jest.mock("@/lib/webrtc", () => ({
  __esModule: true,
  buildICEConfig: jest.fn(async () => ({})),
  PeerSession: jest.fn().mockImplementation((_initiator: boolean, cb: PeerCb) => {
    peerCb = cb;
    peerInstance = {
      setOutgoingVideoEnabled: jest.fn(),
      setOutgoingAudioEnabled: jest.fn(),
      startVideo: jest.fn(async () => ({ id: "local-stream" })),
      stopVideo: jest.fn(),
      sendControl: jest.fn(),
      sendChat: jest.fn(() => true),
      sendTyping: jest.fn(),
      handleSignal: jest.fn(async () => undefined),
      close: jest.fn(),
    };
    return peerInstance;
  }),
}));

// ── Child component doubles: expose only the props the test drives. ──
// Written as JSX (React 19 automatic runtime) so no `require` is needed inside
// the hoisted jest.mock factories.
jest.mock("./components/EntryGate", () => ({
  __esModule: true,
  default: ({ onReady }: { onReady: (lat: number, lng: number) => void }) => (
    <button data-testid="entry-gate" onClick={() => onReady(1, 2)}>
      enter
    </button>
  ),
}));

jest.mock("./components/WorldMap", () => ({
  __esModule: true,
  default: ({
    peers,
    onPeerClick,
  }: {
    peers: Array<{ id: string }>;
    onPeerClick: (id: string) => void;
  }) => (
    <div data-testid="world-map">
      {peers.map((p) => (
        <button key={p.id} onClick={() => onPeerClick(p.id)}>
          peer-{p.id}
        </button>
      ))}
    </div>
  ),
}));

jest.mock("./components/ConnectionPrompt", () => ({
  __esModule: true,
  default: ({
    title,
    onAccept,
    onDecline,
  }: {
    title: string;
    onAccept: () => void;
    onDecline: () => void;
  }) => (
    <div data-testid="connection-prompt">
      <span>{title}</span>
      <button onClick={onAccept}>prompt-accept</button>
      <button onClick={onDecline}>prompt-decline</button>
    </div>
  ),
}));

jest.mock("./components/ChatPanel", () => ({
  __esModule: true,
  default: ({ onStartVideo }: { onStartVideo: () => void }) => (
    <div data-testid="chat-panel">
      <button onClick={onStartVideo}>start-video</button>
    </div>
  ),
}));

jest.mock("./components/VideoPanel", () => ({
  __esModule: true,
  // Surfaces the props the refactor moved into useReciprocalVideo so the test
  // can verify page.tsx actually forwards them and wires the toggles.
  default: ({
    onEnd,
    onToggleMute,
    peerAway,
  }: {
    onEnd: () => void;
    onToggleMute: () => void;
    peerAway: boolean;
  }) => (
    <div data-testid="video-panel" data-peer-away={String(peerAway)}>
      <button onClick={onEnd}>video-end</button>
      <button onClick={onToggleMute}>video-mute</button>
    </div>
  ),
}));

import Home from "./page";

beforeEach(() => {
  pollPeers = [];
  pollSignals = [];
  peerCb = null;
  peerInstance = null;
  // crypto.randomUUID for the session id.
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: () => "test-session-id" },
      configurable: true,
    });
  }
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  jest.clearAllMocks();
});

// Advance fake timers AND flush the microtask queue (poll/join/startPeer awaits).
async function flush(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// Drive the app from the gate to a fully-connected channel with peer "p1".
async function connect() {
  render(<Home />);
  fireEvent.click(screen.getByTestId("entry-gate")); // onReady → join
  await flush(); // join resolves → phase "live" → first poll tick

  pollPeers = [{ id: "p1", lat: 3, lng: 4, busy: false }];
  await flush(1500); // next poll tick surfaces the peer dot

  fireEvent.click(screen.getByText("peer-p1")); // requestConnection → "requesting"
  expect(screen.getByText("Sending signal…")).toBeInTheDocument();

  pollSignals = [{ id: "s1", fromId: "p1", toId: "x", type: "accept", payload: null }];
  await flush(1500); // poll delivers "accept" → startPeer → "connecting"
  pollSignals = [];
  expect(screen.getByText("Connecting…")).toBeInTheDocument();

  // The data channel opens → connected → ChatPanel mounts.
  await act(async () => {
    peerCb!.onChannelOpen();
  });
  expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
}

describe("Home — connection lifecycle (characterization)", () => {
  it("walks gate → requesting → connecting → connected, mounting ChatPanel only on channel-open", async () => {
    await connect();
    // ChatPanel is present only after onChannelOpen (not during "connecting").
    expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
  });
});

describe("Home — reciprocal-video privacy gate (characterization)", () => {
  it("holds the outgoing feed off until presence, enables when mutually present, cuts on peer-away", async () => {
    await connect();

    // Start video via the incoming-request path so we reach video === "active".
    await act(async () => {
      peerCb!.onControl("video-request"); // → video "incoming" prompt
    });
    fireEvent.click(screen.getByText("prompt-accept")); // acceptVideo → startVideo
    await flush(); // startVideo resolves → video "active" → presence effect mounts

    expect(screen.getByTestId("video-panel")).toBeInTheDocument();
    const gate = peerInstance!.setOutgoingVideoEnabled;

    // Fail-closed: at call start the peer is assumed away, so the gate is OFF
    // and never enabled before presence is proven.
    expect(gate).toHaveBeenCalledWith(false);
    expect(gate).not.toHaveBeenCalledWith(true);

    // Peer proves presence → after the resume settle the feed is enabled.
    gate.mockClear();
    await act(async () => {
      peerCb!.onControl("presence-present");
    });
    await flush(200); // > RESUME_DELAY_MS (150)
    expect(gate).toHaveBeenCalledWith(true);

    // Peer steps away → outgoing feed is cut INSTANTLY.
    gate.mockClear();
    await act(async () => {
      peerCb!.onControl("presence-away");
    });
    expect(gate).toHaveBeenCalledWith(false);
  });

  it("forwards reciprocal-video state/handlers from the hook through to VideoPanel", async () => {
    await connect();
    await act(async () => {
      peerCb!.onControl("video-request");
    });
    fireEvent.click(screen.getByText("prompt-accept"));
    await flush();

    // peerAway (owned by useReciprocalVideo) is reflected onto VideoPanel: it
    // starts fail-closed true, then flips false once the peer is present.
    expect(screen.getByTestId("video-panel").dataset.peerAway).toBe("true");
    await act(async () => {
      peerCb!.onControl("presence-present");
    });
    expect(screen.getByTestId("video-panel").dataset.peerAway).toBe("false");

    // The mute toggle is wired through to the hook → PeerSession.
    fireEvent.click(screen.getByText("video-mute"));
    expect(peerInstance!.setOutgoingAudioEnabled).toHaveBeenCalledWith(false);
    expect(peerInstance!.sendControl).toHaveBeenCalledWith("audio-mute");
  });
});
