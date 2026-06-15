/**
 * @jest-environment jsdom
 *
 * useChat — message list, typing indicator, and the Delivery Echo
 * "Sent → Delivered" lifecycle. Behavior verified:
 *   - monotonic session-local ids; "Sent" only when the frame actually went out
 *   - inbound message clears peerTyping
 *   - markDelivered flips the matching OUTBOUND message by id, idempotently
 *     (no new array on a duplicate/foreign/stale ack)
 *   - reset clears messages + peerTyping but keeps the id counter monotonic
 */
import { act, renderHook } from "@testing-library/react";
import { useChat } from "./useChat";
import type { PeerSession } from "@/lib/webrtc";

function makePeerRef(sendChatReturns = true) {
  const sendChat = jest.fn(() => sendChatReturns);
  const sendTyping = jest.fn();
  const ref = { current: { sendChat, sendTyping } as unknown as PeerSession };
  return { ref, sendChat, sendTyping };
}

describe("useChat", () => {
  it("appends an outbound message with a monotonic id and marks it Sent when the frame went out", () => {
    const { ref, sendChat } = makePeerRef(true);
    const { result } = renderHook(() => useChat(ref));

    act(() => result.current.sendMessage("hi"));
    act(() => result.current.sendMessage("again"));

    const msgs = result.current.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ id: 0, mine: true, text: "hi", sent: true });
    expect(msgs[1]).toMatchObject({ id: 1, mine: true, sent: true });
    // sendChat received the same id that was allocated locally.
    expect(sendChat).toHaveBeenNthCalledWith(1, "hi", 0);
    expect(sendChat).toHaveBeenNthCalledWith(2, "again", 1);
  });

  it("does NOT mark Sent when the channel was closed (sendChat returns false)", () => {
    const { ref } = makePeerRef(false);
    const { result } = renderHook(() => useChat(ref));
    act(() => result.current.sendMessage("into the void"));
    expect(result.current.messages[0].sent).toBeUndefined();
  });

  it("appends an inbound message and clears peerTyping", () => {
    const { ref } = makePeerRef();
    const { result } = renderHook(() => useChat(ref));
    act(() => result.current.setPeerTyping(true));
    expect(result.current.peerTyping).toBe(true);

    act(() => result.current.receiveMessage("hello"));
    expect(result.current.peerTyping).toBe(false);
    expect(result.current.messages[0]).toMatchObject({ mine: false, text: "hello" });
  });

  it("flips the matching outbound message to delivered, idempotently", () => {
    const { ref } = makePeerRef();
    const { result } = renderHook(() => useChat(ref));
    act(() => result.current.sendMessage("yo")); // id 0, mine

    act(() => result.current.markDelivered(0));
    expect(result.current.messages[0].delivered).toBe(true);

    // A duplicate / already-delivered ack must NOT produce a new array.
    const before = result.current.messages;
    act(() => result.current.markDelivered(0));
    expect(result.current.messages).toBe(before);

    // A foreign id matches nothing → also no new array.
    act(() => result.current.markDelivered(999));
    expect(result.current.messages).toBe(before);
  });

  it("never marks an INBOUND message delivered (mine guard)", () => {
    const { ref } = makePeerRef();
    const { result } = renderHook(() => useChat(ref));
    act(() => result.current.receiveMessage("from them")); // id 0, NOT mine
    act(() => result.current.markDelivered(0));
    expect(result.current.messages[0].delivered).toBeUndefined();
  });

  it("reset clears messages and peerTyping but keeps ids monotonic", () => {
    const { ref } = makePeerRef();
    const { result } = renderHook(() => useChat(ref));
    act(() => result.current.sendMessage("a")); // id 0
    act(() => result.current.reset());
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.peerTyping).toBe(false);

    // The id counter is session-local and monotonic — NOT reset.
    act(() => result.current.sendMessage("b"));
    expect(result.current.messages[0].id).toBe(1);
  });

  it("sendTyping forwards to the peer session", () => {
    const { ref, sendTyping } = makePeerRef();
    const { result } = renderHook(() => useChat(ref));
    act(() => result.current.sendTyping(true));
    expect(sendTyping).toHaveBeenCalledWith(true);
  });
});
