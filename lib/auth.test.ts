import { verifyToken } from "./auth";

// verifyToken is the heart of the capability-token auth: poll/leave/signal/turn
// all gate on it. Its security contract is (1) constant-time match, (2) never
// throw — timingSafeEqual throws on unequal-length buffers, so the length guard
// matters, and (3) reject anything that isn't a real (row, string-token) pair.

describe("verifyToken", () => {
  // Invariant: the legitimate owner presenting the exact stored token is let in.
  it("returns true when the provided token matches the stored token", () => {
    const token = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";
    expect(verifyToken({ token }, token)).toBe(true);
  });

  // Invariant: a wrong token of the SAME length is rejected. This is the core
  // attack case — an attacker who knows the token length must still be refused.
  it("returns false for a mismatched token of the same length", () => {
    const stored = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";
    const guess = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(stored.length).toBe(guess.length);
    expect(verifyToken({ token: stored }, guess)).toBe(false);
  });

  // Invariant: a length mismatch must return false and NOT throw. Without the
  // length guard, timingSafeEqual throws RangeError on unequal buffers, which
  // would surface as a 500 (and a different observable behavior than a clean
  // 401) — a real information leak / DoS seam.
  it("returns false (does not throw) when token lengths differ", () => {
    const stored = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";
    expect(() => verifyToken({ token: stored }, "short")).not.toThrow();
    expect(verifyToken({ token: stored }, "short")).toBe(false);
    // Longer-than-stored direction too.
    expect(verifyToken({ token: "short-tok" }, stored)).toBe(false);
  });

  // Invariant: no Presence row (unknown / reaped session) is never authorized.
  it("returns false for a null or undefined presenceRow", () => {
    expect(verifyToken(null, "anything-at-all")).toBe(false);
    expect(verifyToken(undefined, "anything-at-all")).toBe(false);
  });

  // Invariant: a non-string / empty provided token is never authorized. Covers
  // the case where a caller omits the token entirely (undefined / null) or sends
  // a non-string from a malformed body.
  it("returns false for a non-string or empty provided token", () => {
    const row = { token: "a1b2c3d4-e5f6-7890-abcd-ef0123456789" };
    expect(verifyToken(row, undefined)).toBe(false);
    expect(verifyToken(row, null)).toBe(false);
    expect(verifyToken(row, "")).toBe(false);
    expect(verifyToken(row, 12345)).toBe(false);
    expect(verifyToken(row, { token: row.token })).toBe(false);
  });
});
