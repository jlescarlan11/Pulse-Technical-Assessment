// The connection state machine, as a pure transition table.
//
// `Conn` is a 5-variant tagged union; the app moves between variants in response
// to user actions (tap a dot, accept/decline a prompt) and inbound signals
// (remote accept, channel open, hang-up). Previously these transitions were
// scattered across page.tsx as imperative `setConn({...})` calls guarded by
// ad-hoc `connRef.current.kind === ...` checks. Centralising them here makes the
// machine explicit, illegal transitions impossible, and the whole thing
// unit-testable without React.
//
// This reducer is PURE — it computes the next state and nothing else. Side
// effects (emitSignal, startPeer, timers, teardown, setOriginPeer, showNotice)
// stay at the call sites in page.tsx, which gate them on the same guards the
// reducer enforces. The single shared peerRef is NOT owned here.

export type Conn =
  | { kind: "idle" }
  | { kind: "requesting"; peerId: string }
  | { kind: "incoming"; peerId: string }
  | { kind: "connecting"; peerId: string }
  | { kind: "connected"; peerId: string };

export type ConnAction =
  // The user tapped a peer dot to request a connection.
  | { type: "REQUEST"; peerId: string }
  // An inbound connection request arrived (shown as the "incoming" prompt).
  | { type: "INCOMING"; peerId: string }
  // The user accepted an incoming prompt.
  | { type: "ACCEPT_INCOMING"; peerId: string }
  // The peer accepted OUR outgoing request.
  | { type: "REMOTE_ACCEPT"; peerId: string }
  // The WebRTC data channel opened — the connection is fully live.
  | { type: "CHANNEL_OPEN"; peerId: string }
  // Return to idle: teardown, decline, hang-up, expiry, or a remote "end".
  | { type: "RESET" };

export const initialConn: Conn = { kind: "idle" };

export function connReducer(state: Conn, action: ConnAction): Conn {
  switch (action.type) {
    case "REQUEST":
      // Only from idle — a second request while busy is ignored (the caller
      // never emits in that case).
      return state.kind === "idle"
        ? { kind: "requesting", peerId: action.peerId }
        : state;

    case "INCOMING":
      // Only surface an inbound request when idle; otherwise the caller
      // auto-declines and state is unchanged.
      return state.kind === "idle"
        ? { kind: "incoming", peerId: action.peerId }
        : state;

    case "ACCEPT_INCOMING":
      // Accept the prompt we're showing for this exact peer.
      return state.kind === "incoming" && state.peerId === action.peerId
        ? { kind: "connecting", peerId: action.peerId }
        : state;

    case "REMOTE_ACCEPT":
      // Our pending request was accepted by the peer we asked.
      return state.kind === "requesting" && state.peerId === action.peerId
        ? { kind: "connecting", peerId: action.peerId }
        : state;

    case "CHANNEL_OPEN":
      // The channel opened for the peer we're negotiating with.
      return state.kind === "connecting" && state.peerId === action.peerId
        ? { kind: "connected", peerId: action.peerId }
        : state;

    case "RESET":
      return { kind: "idle" };
  }
}
