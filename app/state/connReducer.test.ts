// connReducer — the connection state machine, exhaustively. Pure function, no
// React, runs in the default node env. Each case pins a (state, action) → state
// transition, including the guards that previously lived as scattered
// `connRef.current.kind === ...` checks in page.tsx.
import { connReducer, initialConn, type Conn } from "./connReducer";

const requesting = (peerId = "p"): Conn => ({ kind: "requesting", peerId });
const incoming = (peerId = "p"): Conn => ({ kind: "incoming", peerId });
const connecting = (peerId = "p"): Conn => ({ kind: "connecting", peerId });
const connected = (peerId = "p"): Conn => ({ kind: "connected", peerId });

describe("connReducer", () => {
  it("starts idle", () => {
    expect(initialConn).toEqual({ kind: "idle" });
  });

  describe("REQUEST", () => {
    it("idle → requesting", () => {
      expect(connReducer(initialConn, { type: "REQUEST", peerId: "p" })).toEqual(
        requesting("p"),
      );
    });
    it("is ignored when not idle", () => {
      const s = connecting("p");
      expect(connReducer(s, { type: "REQUEST", peerId: "q" })).toBe(s);
    });
  });

  describe("INCOMING", () => {
    it("idle → incoming", () => {
      expect(connReducer(initialConn, { type: "INCOMING", peerId: "p" })).toEqual(
        incoming("p"),
      );
    });
    it("is ignored when busy (caller auto-declines)", () => {
      const s = requesting("p");
      expect(connReducer(s, { type: "INCOMING", peerId: "q" })).toBe(s);
    });
  });

  describe("ACCEPT_INCOMING", () => {
    it("incoming → connecting for the matching peer", () => {
      expect(
        connReducer(incoming("p"), { type: "ACCEPT_INCOMING", peerId: "p" }),
      ).toEqual(connecting("p"));
    });
    it("is ignored for a mismatched peer", () => {
      const s = incoming("p");
      expect(connReducer(s, { type: "ACCEPT_INCOMING", peerId: "other" })).toBe(s);
    });
    it("is ignored when not incoming", () => {
      const s = requesting("p");
      expect(connReducer(s, { type: "ACCEPT_INCOMING", peerId: "p" })).toBe(s);
    });
  });

  describe("REMOTE_ACCEPT", () => {
    it("requesting → connecting for the matching peer", () => {
      expect(
        connReducer(requesting("p"), { type: "REMOTE_ACCEPT", peerId: "p" }),
      ).toEqual(connecting("p"));
    });
    it("is ignored for a mismatched peer (stale accept)", () => {
      const s = requesting("p");
      expect(connReducer(s, { type: "REMOTE_ACCEPT", peerId: "other" })).toBe(s);
    });
    it("is ignored when not requesting", () => {
      const s = incoming("p");
      expect(connReducer(s, { type: "REMOTE_ACCEPT", peerId: "p" })).toBe(s);
    });
  });

  describe("CHANNEL_OPEN", () => {
    it("connecting → connected for the matching peer", () => {
      expect(
        connReducer(connecting("p"), { type: "CHANNEL_OPEN", peerId: "p" }),
      ).toEqual(connected("p"));
    });
    it("is ignored when not connecting (e.g. already connected)", () => {
      const s = connected("p");
      expect(connReducer(s, { type: "CHANNEL_OPEN", peerId: "p" })).toBe(s);
    });
  });

  describe("RESET", () => {
    it.each([
      ["requesting", requesting()],
      ["incoming", incoming()],
      ["connecting", connecting()],
      ["connected", connected()],
    ])("%s → idle", (_label, state) => {
      expect(connReducer(state, { type: "RESET" })).toEqual({ kind: "idle" });
    });
  });
});
