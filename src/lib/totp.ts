import { createHmac } from "node:crypto";

/**
 * RFC 6238 TOTP, in the one shape this server needs: a shared secret typed into
 * an authenticator, turned into the six digits a login form is asking for.
 *
 * Both ConnectWise Automate and ConnectWise Control can require two-factor on
 * the account an integration logs in as, and neither offers a headless way past
 * it. The clean answer is a dedicated API service account exempt from 2FA; where
 * the account has to keep 2FA, the operator gives this server the same seed they
 * enrolled in their authenticator and it generates the code per login.
 *
 * node:crypto only — a dependency for thirty lines of HMAC is not worth the
 * supply chain.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode a base32 secret as authenticators print it: case-insensitive, spaces
 * and dashes ignored, `=` padding optional. A hex secret (`0x…` or an even-length
 * run of hex digits that is not valid base32) is accepted too, because some
 * products show the seed that way.
 */
export function base32Decode(secret: string): Buffer {
  const cleaned = secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) throw new Error("TOTP secret is empty");
  if (/^0X[0-9A-F]+$/.test(cleaned) && (cleaned.length - 2) % 2 === 0) {
    return Buffer.from(cleaned.slice(2), "hex");
  }
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`TOTP secret is not valid base32: unexpected character "${char}"`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  if (out.length === 0) throw new Error("TOTP secret decoded to no bytes");
  return Buffer.from(out);
}

export interface TotpOptions {
  /** Unix milliseconds. Defaults to now. */
  now?: number;
  /** Time step in seconds. RFC 6238 default, and what every authenticator uses. */
  step?: number;
  /** Digits in the code. Six everywhere in practice; the RFC's test vectors use eight. */
  digits?: number;
  /** HMAC hash. SHA-1 is the universal default. */
  algorithm?: "sha1" | "sha256" | "sha512";
}

/** RFC 4226 HOTP over an already-decoded key. */
export function hotp(key: Buffer, counter: number, digits = 6, algorithm = "sha1"): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code for `secret` at this moment. */
export function totp(secret: string, options: TotpOptions = {}): string {
  const { now = Date.now(), step = 30, digits = 6, algorithm = "sha1" } = options;
  const counter = Math.floor(now / 1000 / step);
  return hotp(base32Decode(secret), counter, digits, algorithm);
}

/** Whether a response's text reads like a demand for a second factor. */
export function looksLikeTwoFactorChallenge(text: string): boolean {
  return /two[- ]?factor|2fa|one[- ]?time[- ]?(password|code|passcode)|otp\b|authenticator|passcode required/i.test(
    text,
  );
}
