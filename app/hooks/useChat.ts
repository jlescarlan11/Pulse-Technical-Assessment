import { useRef, useState } from "react";
import type { PeerSession } from "@/lib/webrtc";
import type { ChatMessage } from "../components/ChatPanel";

export interface UseChat {
  // The in-memory, session-local message list (rendered by ChatPanel).
  messages: ChatMessage[];
  // True while the peer is composing (peer-driven, ephemeral).
  peerTyping: boolean;
  // Set the peer's typing flag straight from the data-channel onTyping callback.
  setPeerTyping: (on: boolean) => void;
  // Handle an inbound chat message (onChat): a real message also means the peer
  // has stopped typing.
  receiveMessage: (text: string) => void;
  // Delivery Echo: flip the matching OUTBOUND message to delivered, by id.
  markDelivered: (id: number) => void;
  // Send a chat message: append locally (owning the id), then transmit that
  // same id; mark "Sent" only if the frame actually went out.
  sendMessage: (text: string) => void;
  // Broadcast local typing state over the data channel.
  sendTyping: (on: boolean) => void;
  // Clear chat state on teardown. msgId is intentionally NOT reset — it is a
  // monotonic, session-local counter.
  reset: () => void;
}

// Chat over the P2P data channel: the message list, the typing indicator, and
// the Delivery Echo "Sent → Delivered" lifecycle. The PeerSession itself stays
// owned by the page (shared peerRef); this hook receives it and reads
// `peerRef.current` at call time so a torn-down/replaced session is handled by
// safeSend's no-op.
export function useChat(
  peerRef: React.RefObject<PeerSession | null>,
): UseChat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peerTyping, setPeerTyping] = useState(false);
  const msgId = useRef(0);

  function addMessage(mine: boolean, text: string): number {
    // createdAt is a CLIENT-ONLY wall-clock stamp (Date.now(), ms epoch) read
    // solely by ChatPanel's Fade Trails decay. It is NOT sent over the wire,
    // NOT persisted, and does NOT change a message's real lifetime — messages
    // stay in-memory and are cleared on teardown.
    //
    // Delivery Echo: allocate the id BEFORE the setMessages closure so we can
    // return it. The outbound send rides this SAME id on the wire ({t:"msg",
    // id}); the peer echoes it back in an ack and markDelivered flips this exact
    // message to Delivered by id. id is monotonic & session-local, never sent
    // for incoming-tagging purposes beyond this.
    const id = msgId.current++;
    setMessages((prev) => [...prev, { id, mine, text, createdAt: Date.now() }]);
    return id;
  }

  function receiveMessage(text: string): void {
    // A real message means they have stopped typing.
    setPeerTyping(false);
    addMessage(false, text);
  }

  function markDelivered(id: number): void {
    // Delivery Echo (Story C): flip exactly the matching OUTBOUND message to
    // delivered, matched BY ID (not array position). Pure functional update
    // keyed on id makes it idempotent — a duplicate, stale, or foreign ack maps
    // to an already-delivered or non-matching message and returns prev
    // unchanged, so no re-render / re-animate. Order-independent: rapid-fire
    // acks each land on their own id.
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (m.id === id && m.mine && !m.delivered) {
          changed = true;
          return { ...m, delivered: true };
        }
        return m;
      });
      return changed ? next : prev;
    });
  }

  function sendMessage(text: string): void {
    // Delivery Echo: append locally first so we own the id, then send that SAME
    // id on the wire. The peer's ack echoes it back and flips this message to
    // Delivered (markDelivered, by id). sendChat returns whether the frame
    // actually went out over an open channel — only then do we mark the message
    // "Sent" (honest: a no-op'd send on a closed channel claims nothing).
    const id = addMessage(true, text);
    const sent = peerRef.current?.sendChat(text, id) ?? false;
    if (sent) {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, sent: true } : m)),
      );
    }
  }

  function sendTyping(on: boolean): void {
    peerRef.current?.sendTyping(on);
  }

  function reset(): void {
    setMessages([]);
    setPeerTyping(false);
  }

  return {
    messages,
    peerTyping,
    setPeerTyping,
    receiveMessage,
    markDelivered,
    sendMessage,
    sendTyping,
    reset,
  };
}
