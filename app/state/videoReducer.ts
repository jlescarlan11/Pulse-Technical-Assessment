// The video-call state machine, as a pure transition table.
//
// VideoState tracks the negotiation of a video call layered on top of an
// already-connected chat: nobody → one side asks → the other accepts → active,
// with decline/end returning to "none". Like connReducer, this centralises the
// transitions that were imperative setVideo(...) calls and keeps the reducer
// PURE — getUserMedia, sendControl, stream setters, and the presence engine all
// stay at the call sites.
//
// Faithful to the prior behaviour: ACTIVATE and END are unconditional (the old
// code set "active"/"none" without re-checking state, including inside the
// async startVideo().then). REQUEST_* are guarded on "none", matching the
// call-site guards they replace.

export type VideoState = "none" | "requesting" | "incoming" | "active";

export type VideoAction =
  // WE asked the peer to start video.
  | { type: "REQUEST_OUTGOING" }
  // The peer asked US (shows the incoming-video prompt).
  | { type: "REQUEST_INCOMING" }
  // A side accepted and the local camera came up — the call is live.
  | { type: "ACTIVATE" }
  // Decline, hang-up, remote end, camera failure, or teardown.
  | { type: "END" };

export const initialVideo: VideoState = "none";

export function videoReducer(
  state: VideoState,
  action: VideoAction,
): VideoState {
  switch (action.type) {
    case "REQUEST_OUTGOING":
      return state === "none" ? "requesting" : state;
    case "REQUEST_INCOMING":
      return state === "none" ? "incoming" : state;
    case "ACTIVATE":
      return "active";
    case "END":
      return "none";
  }
}
