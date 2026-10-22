import type { ScreenConnectConfig } from "../config.js";
import { CwApiError, type ClientDeps, type Query } from "./psa-client.js";
import { randomBytes } from "node:crypto";

import { looksLikeTwoFactorChallenge, totp } from "./totp.js";

/**
 * Minimal ConnectWise Control (ScreenConnect) client — BETA.
 *
 * Control has no clean public REST API; integrations drive the host-page
 * `/Services/*.ashx` JSON endpoints behind forms authentication. This client
 * logs in via AuthenticationService (with a generated one-time passcode when a
 * TOTP seed is configured), keeps the session cookies, and echoes the
 * anti-forgery token on writes. Endpoint shapes vary by Control version, so the
 * `screenconnect_api_request` passthrough is the reliable surface; convenience
 * tools are best-effort. Auth/CSRF behavior is instance- and version-dependent.
 */
/**
 * ScreenConnect's SecurityOperationResult, as the server itself publishes it in
 * Script.ashx. TryLogin answers HTTP 200 whether it accepts or refuses, and puts
 * the verdict in the body as one of these numbers — so the status code alone
 * cannot tell a session from a rejected password.
 */
const SECURITY_RESULT: Record<number, string> = {
  0: "Unknown",
  1: "Success",
  2: "UserNameInvalid",
  3: "LockedOut",
  4: "NewPasswordInvalid",
  5: "NewPasswordMatchInvalid",
  6: "NotSupported",
  7: "PasswordInvalid",
  8: "OneTimePasswordProviderInvalid",
  9: "OneTimePasswordUserKeyInvalid",
  10: "OneTimePasswordInvalid",
  11: "OneTimePasswordRequired",
  12: "ChangeablePasswordExpired",
  13: "UnchangeablePasswordExpired",
  14: "AccessPolicyViolated",
  15: "CurrentPasswordInvalid",
  16: "ApprovalCodeInvalid",
  17: "UnexpectedFailure",
  18: "NotAuthenticated",
  19: "CredentialsInvalid",
};
const RESULT_SUCCESS = 1;
/** Verdicts that mean "send a passcode", not "wrong password". */
const RESULT_NEEDS_OTP = new Set([8, 9, 10, 11]);

/** The 16-character alphanumeric nonce the login page generates per attempt. */
function securityNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join("");
}

export class ScreenConnectClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private cookies?: string;
  private antiForgeryToken?: string;

  constructor(
    private readonly cfg: ScreenConnectConfig,
    deps: ClientDeps = {},
  ) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** The error a two-factor demand deserves: not "wrong password". */
  private twoFactorError(status: number): CwApiError {
    return new CwApiError(
      `ScreenConnect login requires a one-time passcode: this Control account has two-factor ` +
        `authentication enabled and no passcode was sent. Either use a dedicated API service account ` +
        `exempt from two-factor, or set CW_SCREENCONNECT_TOTP_SECRET (Claude Desktop: Settings > ` +
        `Extensions field "Control TOTP secret") to the same seed the account's authenticator was ` +
        `enrolled with.`,
      status,
    );
  }

  /** Merge a response's Set-Cookie headers into the session jar and pick up the anti-forgery token. */
  private mergeSetCookies(res: Response): void {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) {
      const single = res.headers.get("set-cookie");
      if (single) setCookies.push(single);
    }
    if (setCookies.length === 0) return;
    const jar = new Map<string, string>();
    for (const c of (this.cookies ? this.cookies.split("; ") : [])) {
      const [k, ...v] = c.split("=");
      if (k) jar.set(k, v.join("="));
    }
    for (const c of setCookies) {
      const pair = c.split(";")[0];
      const [k, ...v] = pair.split("=");
      if (k) jar.set(k, v.join("="));
    }
    this.cookies = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const af = setCookies.find((c) => /antiforgery/i.test(c));
    if (af) this.antiForgeryToken = decodeURIComponent(af.split("=")[1]?.split(";")[0] ?? "");
  }

  /**
   * Prime the anti-forgery token before authenticating. Control serves it in the
   * login page's inlined `SC.util.mergeIntoContext({... "antiForgeryToken": ...})`
   * block — not as a cookie, which is why scraping Set-Cookie alone never found
   * one. Every `/Services/*.ashx` call echoes it back as X-Anti-Forgery-Token.
   */
  private async primeAntiForgery(): Promise<void> {
    if (this.antiForgeryToken && this.cookies) return;
    const res = await this.fetchImpl(`${this.base}/Login`, {
      method: "GET",
      headers: { Accept: "text/html" },
    }).catch(() => undefined);
    if (!res) return;
    this.mergeSetCookies(res);
    const html = await res.text().catch(() => "");
    const match = /"antiForgeryToken"\s*:\s*"([^"]*)"/.exec(html);
    if (match?.[1]) this.antiForgeryToken = match[1];
  }

  /** TryLogin's numeric verdict, or undefined when the body is not one. */
  private static parseResult(text: string): number | undefined {
    const trimmed = text.trim();
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "number") return parsed;
    } catch {
      /* not JSON — fall through */
    }
    return undefined;
  }

  /** POST TryLogin with an optional one-time passcode; returns the response and its body text. */
  private async tryLogin(oneTimePassword: string): Promise<{ res: Response; text: string }> {
    const res = await this.fetchImpl(`${this.base}/Services/AuthenticationService.ashx/TryLogin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.cookies ? { Cookie: this.cookies } : {}),
        ...(this.antiForgeryToken ? { "X-Anti-Forgery-Token": this.antiForgeryToken } : {}),
      },
      // The server's own signature, from Script.ashx:
      // TryLogin(userName, password, oneTimePassword, shouldTrust, securityNonce).
      // shouldTrust is a Boolean — passing a string here is what made .NET fail to
      // bind the argument and throw before the password was ever checked.
      body: JSON.stringify([
        this.cfg.username,
        this.cfg.password,
        oneTimePassword,
        false,
        securityNonce(),
      ]),
    });
    return { res, text: await res.text().catch(() => "") };
  }

  private async ensureSession(): Promise<void> {
    if (this.cookies && this.antiForgeryToken) return;
    await this.primeAntiForgery();

    // Control asks for the passcode as a second step on some builds: the first
    // TryLogin answers OneTimePasswordRequired rather than handing back a session.
    let { res, text } = await this.tryLogin(this.cfg.totpSecret ? totp(this.cfg.totpSecret) : "");
    let result = ScreenConnectClient.parseResult(text);

    if (result !== undefined && RESULT_NEEDS_OTP.has(result) && this.cfg.totpSecret) {
      ({ res, text } = await this.tryLogin(totp(this.cfg.totpSecret)));
      result = ScreenConnectClient.parseResult(text);
    }

    const wantsOtp =
      result !== undefined ? RESULT_NEEDS_OTP.has(result) : looksLikeTwoFactorChallenge(text);
    if (wantsOtp && !this.cfg.totpSecret) throw this.twoFactorError(res.status);

    if (!res.ok) {
      throw new CwApiError(
        `ScreenConnect login failed (${res.status} ${res.statusText})${text ? `: ${text.slice(0, 200)}` : ""}`,
        res.status,
      );
    }
    if (result !== undefined && result !== RESULT_SUCCESS) {
      throw new CwApiError(
        `ScreenConnect login refused: ${SECURITY_RESULT[result] ?? `result ${result}`}`,
        401,
      );
    }

    this.mergeSetCookies(res);
    if (!this.cookies) {
      throw new CwApiError("ScreenConnect login returned no session cookie", 500);
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
    isRetry = false,
  ): Promise<T> {
    await this.ensureSession();
    if (!path.startsWith("/")) path = `/${path}`;
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Cookie: this.cookies!,
        Accept: "application/json",
        ...(this.antiForgeryToken ? { "X-Anti-Forgery-Token": this.antiForgeryToken } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if ((res.status === 401 || res.status === 403) && !isRetry) {
      this.cookies = undefined;
      this.antiForgeryToken = undefined;
      return this.request<T>(method, path, opts, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CwApiError(
        `${res.status} ${res.statusText} for ${path}${text ? `: ${text.slice(0, 200)}` : ""}`,
        res.status,
      );
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    return (ct.includes("json") ? await res.json() : await res.text()) as T;
  }

  /** Best-effort host session list via the standard PageService endpoint. */
  async listSessions(sessionType = 0): Promise<unknown> {
    return this.request("POST", "/Services/PageService.ashx/GetHostSessionInfo", {
      body: [sessionType, [], "", 0, "", 100],
    });
  }
}
