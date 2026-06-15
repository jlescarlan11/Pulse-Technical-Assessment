// videoReducer — the video-call state machine. Pure, node env.
import { videoReducer, initialVideo, type VideoState } from "./videoReducer";

describe("videoReducer", () => {
  it("starts at none", () => {
    expect(initialVideo).toBe("none");
  });

  describe("REQUEST_OUTGOING", () => {
    it("none → requesting", () => {
      expect(videoReducer("none", { type: "REQUEST_OUTGOING" })).toBe("requesting");
    });
    it("is ignored unless none", () => {
      expect(videoReducer("active", { type: "REQUEST_OUTGOING" })).toBe("active");
      expect(videoReducer("incoming", { type: "REQUEST_OUTGOING" })).toBe("incoming");
    });
  });

  describe("REQUEST_INCOMING", () => {
    it("none → incoming", () => {
      expect(videoReducer("none", { type: "REQUEST_INCOMING" })).toBe("incoming");
    });
    it("is ignored unless none", () => {
      expect(videoReducer("requesting", { type: "REQUEST_INCOMING" })).toBe("requesting");
    });
  });

  describe("ACTIVATE", () => {
    it.each<VideoState>(["requesting", "incoming", "none", "active"])(
      "%s → active (unconditional, faithful to prior behaviour)",
      (state) => {
        expect(videoReducer(state, { type: "ACTIVATE" })).toBe("active");
      },
    );
  });

  describe("END", () => {
    it.each<VideoState>(["requesting", "incoming", "active", "none"])(
      "%s → none",
      (state) => {
        expect(videoReducer(state, { type: "END" })).toBe("none");
      },
    );
  });
});
