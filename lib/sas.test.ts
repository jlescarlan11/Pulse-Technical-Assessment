import { parseFingerprint, deriveSAS, SAS_VERSION } from "./sas";
import { SAS_WORDLIST } from "./sas-wordlist";

// Two realistic, distinct SHA-256 DTLS fingerprints (same length, differ in
// many positions). Used as the canonical fixtures across the symmetry,
// determinism, and sensitivity tests.
const FP_A =
  "sha-256 ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89";
const FP_B =
  "sha-256 11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00";

function words(phrase: { word: string }[]): string[] {
  return phrase.map((t) => t.word);
}

describe("parseFingerprint", () => {
  it("extracts and normalizes the fingerprint from a realistic multi-line SDP with CRLF and trailing whitespace", () => {
    const sdp = [
      "v=0",
      "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "a=group:BUNDLE 0",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      "a=ice-ufrag:F7gI",
      "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89   ",
      "a=setup:actpass",
    ].join("\r\n");

    expect(parseFingerprint(sdp)).toBe(
      "sha-256 ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89",
    );
  });

  it("uses the first fingerprint line when multiple are present", () => {
    const sdp = [
      "a=fingerprint:sha-256 AA:BB:CC:DD",
      "a=fingerprint:sha-256 99:88:77:66",
    ].join("\r\n");

    expect(parseFingerprint(sdp)).toBe("sha-256 aa:bb:cc:dd");
  });

  it("returns null for an SDP with no fingerprint line (verification unavailable)", () => {
    const sdp = [
      "v=0",
      "o=- 1 2 IN IP4 127.0.0.1",
      "s=-",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "a=setup:actpass",
    ].join("\r\n");

    expect(parseFingerprint(sdp)).toBeNull();
  });

  it("returns null for empty or non-string input", () => {
    expect(parseFingerprint("")).toBeNull();
    // @ts-expect-error — exercising the runtime guard against non-string input
    expect(parseFingerprint(undefined)).toBeNull();
  });
});

describe("deriveSAS", () => {
  it("is symmetric: deriveSAS(A, B) deep-equals deriveSAS(B, A)", async () => {
    const ab = await deriveSAS(FP_A, FP_B);
    const ba = await deriveSAS(FP_B, FP_A);
    expect(ab).toEqual(ba);
  });

  it("is deterministic: repeated calls with the same inputs return the same phrase", async () => {
    const first = await deriveSAS(FP_A, FP_B);
    const second = await deriveSAS(FP_A, FP_B);
    expect(first).toEqual(second);
  });

  it("returns exactly 5 tokens, each a valid wordlist entry", async () => {
    const phrase = await deriveSAS(FP_A, FP_B);
    expect(phrase).toHaveLength(5);
    for (const token of phrase) {
      expect(typeof token.word).toBe("string");
      expect(typeof token.emoji).toBe("string");
      expect(SAS_WORDLIST).toContainEqual(token);
    }
  });

  it("is sensitive: fingerprints differing by a single hex char produce a different phrase", async () => {
    // Flip the final hex digit of FP_B only.
    const fpBMutated = FP_B.replace(/0$/, "1");
    expect(fpBMutated).not.toBe(FP_B);

    const original = await deriveSAS(FP_A, FP_B);
    const mutated = await deriveSAS(FP_A, fpBMutated);
    expect(words(mutated)).not.toEqual(words(original));
  });

  it("locks a known fingerprint pair to a fixed phrase so a SAS_VERSION/wordlist change is caught", async () => {
    // This snapshot is bound to SAS_VERSION + the wordlist ordering. If either
    // changes, this assertion fails on purpose — that is the whole point of
    // baking SAS_VERSION into the hash: a silent change must not pass review.
    const phrase = await deriveSAS(FP_A, FP_B);
    expect(SAS_VERSION).toBe("pulse-sas-v2");
    expect(words(phrase)).toMatchInlineSnapshot(`
[
  "honey",
  "wagon",
  "yogurt",
  "engine",
  "candy",
]
`);
  });
});

describe("SAS_WORDLIST", () => {
  it("has exactly 256 entries (one unbiased byte per token)", () => {
    expect(SAS_WORDLIST).toHaveLength(256);
  });

  it("has no duplicate words", () => {
    const unique = new Set(SAS_WORDLIST.map((t) => t.word));
    expect(unique.size).toBe(256);
  });

  it("has no duplicate emoji", () => {
    const unique = new Set(SAS_WORDLIST.map((t) => t.emoji));
    expect(unique.size).toBe(256);
  });
});
