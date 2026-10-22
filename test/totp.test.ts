// RFC 6238 reference vectors. The seed in the RFC is the ASCII string
// "12345678901234567890"; authenticators (and the ConnectWise products) hand
// out the same bytes as base32, which is what this implementation takes.
import { describe, expect, it } from "vitest";
import { base32Decode, hotp, looksLikeTwoFactorChallenge, totp } from "../src/lib/totp.js";

const ASCII_SEED = "12345678901234567890";
const BASE32_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32Decode", () => {
  it("decodes the RFC seed", () => {
    expect(base32Decode(BASE32_SEED).toString("ascii")).toBe(ASCII_SEED);
  });

  it("ignores the spacing, case and padding an authenticator prints", () => {
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").toString("ascii")).toBe(ASCII_SEED);
    expect(base32Decode("MZXW6===").toString("ascii")).toBe("foo");
  });

  it("accepts a hex seed", () => {
    expect(base32Decode("0x3132333435").toString("ascii")).toBe("12345");
  });

  it("refuses a secret that is neither", () => {
    expect(() => base32Decode("not!base32")).toThrow(/not valid base32/);
    expect(() => base32Decode("  ")).toThrow(/empty/);
  });
});

describe("hotp", () => {
  // RFC 4226 Appendix D, the 6-digit values for counters 0..9.
  const RFC4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];

  it("matches the RFC 4226 vectors", () => {
    const key = Buffer.from(ASCII_SEED, "ascii");
    RFC4226.forEach((expected, counter) => {
      expect(hotp(key, counter), `counter ${counter}`).toBe(expected);
    });
  });
});

describe("totp", () => {
  // RFC 6238 Appendix B, the SHA-1 rows (8 digits, 30-second step).
  const RFC6238_SHA1: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it("matches the RFC 6238 SHA-1 vectors", () => {
    for (const [seconds, expected] of RFC6238_SHA1) {
      expect(totp(BASE32_SEED, { now: seconds * 1000, digits: 8 }), `T=${seconds}`).toBe(expected);
    }
  });

  it("produces the six digits a login form asks for", () => {
    const code = totp(BASE32_SEED, { now: 59_000 });
    expect(code).toMatch(/^\d{6}$/);
    // The six-digit code is the eight-digit one truncated from the left.
    expect(code).toBe("287082");
  });

  it("holds steady inside a step and changes across one", () => {
    // A step boundary, so +29s is inside the same window and +31s is not.
    const base = 1_700_000_040_000;
    expect(totp(BASE32_SEED, { now: base })).toBe(totp(BASE32_SEED, { now: base + 29_000 }));
    expect(totp(BASE32_SEED, { now: base })).not.toBe(totp(BASE32_SEED, { now: base + 31_000 }));
  });
});

describe("looksLikeTwoFactorChallenge", () => {
  it("recognizes how each product words it", () => {
    for (const text of [
      "TwoFactorPasscode is required",
      "Two-factor authentication required",
      "Please enter your one-time password",
      "Invalid OTP",
      "authenticator code required",
    ]) {
      expect(looksLikeTwoFactorChallenge(text), text).toBe(true);
    }
    expect(looksLikeTwoFactorChallenge("Invalid username or password")).toBe(false);
  });
});
