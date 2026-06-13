import { randomUUID } from "node:crypto";
import { isValidId } from "./validate";

// isValidId is the boundary gate every id-bearing route runs first: string,
// length 8–64, charset /^[A-Za-z0-9_-]+$/. It protects against oversized inputs
// and out-of-charset values reaching the DB layer.

describe("isValidId", () => {
  // Invariant: the real-world id the client actually generates is accepted.
  it("accepts a crypto.randomUUID() value (36 chars, hyphens)", () => {
    const id = randomUUID();
    expect(id).toHaveLength(36);
    expect(isValidId(id)).toBe(true);
  });

  // Invariant: the length boundaries are inclusive at 8 and 64, exclusive
  // outside. Off-by-one on a length guard is a classic regression.
  it("accepts boundary lengths 8 and 64", () => {
    expect(isValidId("a".repeat(8))).toBe(true);
    expect(isValidId("a".repeat(64))).toBe(true);
  });

  it("rejects lengths just outside the bounds (7 and 65)", () => {
    expect(isValidId("a".repeat(7))).toBe(false);
    expect(isValidId("a".repeat(65))).toBe(false);
  });

  // Invariant: non-strings never pass the type narrowing guard.
  it("rejects non-string inputs", () => {
    expect(isValidId(12345678)).toBe(false);
    expect(isValidId(null)).toBe(false);
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId({ id: "abcdefgh" })).toBe(false);
    expect(isValidId(["abcdefgh"])).toBe(false);
  });

  // Invariant: out-of-charset content is rejected. Spaces, path/SQL-ish
  // characters, and a megabyte-long string must all fail before any DB work.
  it("rejects disallowed charset and oversized input", () => {
    expect(isValidId("has space")).toBe(false);
    expect(isValidId("semi;colon")).toBe(false);
    expect(isValidId("slash/path")).toBe(false);
    expect(isValidId("dollar$ign")).toBe(false);
    expect(isValidId("emoji-\u{1F600}-id")).toBe(false);
    // 1 MB string: rejected on length (and would be expensive to regex-scan if
    // the length check were ever removed).
    expect(isValidId("a".repeat(1024 * 1024))).toBe(false);
  });

  // Invariant: the full allowed charset (letters, digits, underscore, hyphen)
  // is accepted so legitimate ids are never wrongly rejected.
  it("accepts the full allowed charset", () => {
    expect(isValidId("AZaz09_-AZaz")).toBe(true);
  });
});
