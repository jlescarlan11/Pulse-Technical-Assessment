/**
 * @jest-environment jsdom
 *
 * useReciprocalVideo — the privacy-critical mutual-presence engine, in
 * isolation. Pins the invariants the whole feature exists to guarantee (R1/R2/
 * R4): born-gated fail-closed, enable only once mutually present, instant cut
 * on peer-away, fail-closed staleness, and manual mute/camera intent folded
 * into the gate. A mocked peerRef lets us assert the gate primitive
 * (setOutgoingVideoEnabled) directly.
 */
import { act, renderHook } from "@testing-library/react";
import { useReciprocalVideo } from "./useReciprocalVideo";
import type { PeerSession } from "@/lib/webrtc";

function makePeerRef() {
  const setOutgoingVideoEnabled = jest.fn();
  const setOutgoingAudioEnabled = jest.fn();
  const sendControl = jest.fn();
  const ref = {
    current: {
      setOutgoingVideoEnabled,
      setOutgoingAudioEnabled,
      sendControl,
    } as unknown as PeerSession,
  };
  return { ref, setOutgoingVideoEnabled, setOutgoingAudioEnabled, sendControl };
}

const RESUME_DELAY_MS = 150;
const HEARTBEAT_INTERVAL_MS = 2_000;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

// Render the hook and transition into an active call (effect mounts).
function renderActive(peerRef: ReturnType<typeof makePeerRef>["ref"]) {
  const view = renderHook(({ video }) => useReciprocalVideo(peerRef, video), {
    initialProps: { video: "none" as const },
  });
  act(() => view.rerender({ video: "active" as const }));
  return view;
}

describe("useReciprocalVideo", () => {
  it("is born gated: holds the feed OFF until presence is proven (R2/R4)", () => {
    const { ref, setOutgoingVideoEnabled } = makePeerRef();
    renderActive(ref);
    // peerAway seeds true (fail-closed) → the gate computes shouldSend=false.
    expect(setOutgoingVideoEnabled).toHaveBeenCalledWith(false);
    expect(setOutgoingVideoEnabled).not.toHaveBeenCalledWith(true);
  });

  it("enables the feed once the peer is present, after the resume settle", () => {
    const { ref, setOutgoingVideoEnabled } = makePeerRef();
    const { result } = renderActive(ref);

    setOutgoingVideoEnabled.mockClear();
    act(() => result.current.notePeerPresent());
    // Resume is delayed to avoid strobing — not enabled yet.
    expect(setOutgoingVideoEnabled).not.toHaveBeenCalledWith(true);
    act(() => jest.advanceTimersByTime(RESUME_DELAY_MS));
    expect(setOutgoingVideoEnabled).toHaveBeenCalledWith(true);
  });

  it("cuts the feed INSTANTLY when the peer steps away", () => {
    const { ref, setOutgoingVideoEnabled } = makePeerRef();
    const { result } = renderActive(ref);
    act(() => result.current.notePeerPresent());
    act(() => jest.advanceTimersByTime(RESUME_DELAY_MS));

    setOutgoingVideoEnabled.mockClear();
    act(() => result.current.notePeerAway());
    expect(setOutgoingVideoEnabled).toHaveBeenCalledWith(false);
    expect(setOutgoingVideoEnabled).not.toHaveBeenCalledWith(true);
  });

  it("fail-closed staleness: a silent peer is treated as away (R4)", () => {
    const { ref, setOutgoingVideoEnabled } = makePeerRef();
    const { result } = renderActive(ref);
    act(() => result.current.notePeerPresent());
    act(() => jest.advanceTimersByTime(RESUME_DELAY_MS));
    expect(setOutgoingVideoEnabled).toHaveBeenCalledWith(true);

    // No further heartbeats: the staleness check (HEARTBEAT_TIMEOUT_MS = 4s)
    // fires on a heartbeat tick and cuts the feed.
    setOutgoingVideoEnabled.mockClear();
    act(() => jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3));
    expect(setOutgoingVideoEnabled).toHaveBeenCalledWith(false);
    expect(result.current.peerAway).toBe(true);
  });

  it("toggleMute flips the audio track and signals the peer", () => {
    const { ref, setOutgoingAudioEnabled, sendControl } = makePeerRef();
    const { result } = renderActive(ref);
    act(() => result.current.toggleMute());
    expect(result.current.isMuted).toBe(true);
    expect(setOutgoingAudioEnabled).toHaveBeenCalledWith(false);
    expect(sendControl).toHaveBeenCalledWith("audio-mute");
  });

  it("toggleCamera off cuts the outgoing video regardless of presence", () => {
    const { ref, setOutgoingVideoEnabled, sendControl } = makePeerRef();
    const { result } = renderActive(ref);
    // Become mutually present and enabled first.
    act(() => result.current.notePeerPresent());
    act(() => jest.advanceTimersByTime(RESUME_DELAY_MS));

    setOutgoingVideoEnabled.mockClear();
    act(() => result.current.toggleCamera()); // turn camera OFF
    expect(result.current.isCameraOn).toBe(false);
    expect(setOutgoingVideoEnabled).toHaveBeenCalledWith(false);
    expect(sendControl).toHaveBeenCalledWith("video-manual-off");
  });

  it("resetPresence returns peerAway to fail-closed for the next call", () => {
    const { ref } = makePeerRef();
    const { result } = renderActive(ref);
    act(() => result.current.notePeerPresent());
    expect(result.current.peerAway).toBe(false);
    act(() => result.current.resetPresence());
    expect(result.current.peerAway).toBe(true);
    expect(result.current.localAway).toBe(false);
  });
});
