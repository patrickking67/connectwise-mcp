import type { AutomateConfig } from "../config.js";
import { CwApiError, type ClientDeps, type Query } from "./psa-client.js";
import { looksLikeTwoFactorChallenge, totp } from "./totp.js";

interface TokenResponse {
  AccessToken?: string;
  ExpirationDate?: string;
}

/**
 * Minimal ConnectWise Automate REST client.
 * Auth: POST /cwa/api/v1/apitoken with username/password (plus a generated
 * TwoFactorPasscode when a TOTP seed is configured), then Bearer token.
 * Tokens are cached and refreshed on expiry or 401.
 */
export class AutomateClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly cfg: AutomateConfig,
    deps: ClientDeps = {},
  ) {
    this.apiBase = `${cfg.baseUrl}/cwa/api/v1`;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  private async ensureToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    // TwoFactorPasscode is only sent when a seed is configured. Automate accounts
    // with two-factor enabled cannot log in headlessly without it, and an account
    // without two-factor rejects an unexpected passcode.
    const credentials: Record<string, string> = {
      UserName: this.cfg.username,
      Password: this.cfg.password,
    };
    if (this.cfg.totpSecret) credentials.TwoFactorPasscode = totp(this.cfg.totpSecret);

    const response = await this.fetchImpl(`${this.apiBase}/apitoken`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ClientId: this.cfg.clientId,
      },
      body: JSON.stringify(credentials),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // 405 from the token endpoint means the path is wrong, not the credentials:
      // the base URL is pointing somewhere other than the Automate server root.
      let hint =
        response.status === 405
          ? ` — the token endpoint did not accept POST at ${this.apiBase}/apitoken, so CW_AUTOMATE_URL is not the Automate server root; use https://<host> with no path`
          : "";
      // A two-factor demand is not a wrong password, and saying "authentication
      // failed" sends people to reset a credential that was never the problem.
      if (!this.cfg.totpSecret && looksLikeTwoFactorChallenge(detail)) {
        hint =
          ` — this Automate account has two-factor authentication enabled, and no passcode was sent. ` +
          `Either use a dedicated API service account exempt from two-factor, or set CW_AUTOMATE_TOTP_SECRET ` +
          `(Claude Desktop: Settings > Extensions field "Automate TOTP secret") to the same seed the account's ` +
          `authenticator was enrolled with.`;
      } else if (detail) {
        hint += `: ${detail.slice(0, 200)}`;
      }
      throw new CwApiError(
        `Automate authentication failed (${response.status} ${response.statusText})${hint}`,
        response.status,
      );
    }
    const body = (await response.json()) as TokenResponse;
    if (!body.AccessToken) {
      throw new CwApiError("Automate authentication returned no AccessToken", 500);
    }
    const expiresAt = body.ExpirationDate ? Date.parse(body.ExpirationDate) : Date.now() + 30 * 60_000;
    this.token = { value: body.AccessToken, expiresAt };
    return body.AccessToken;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
    isRetry = false,
  ): Promise<T> {
    if (!path.startsWith("/")) path = `/${path}`;
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    const token = await this.ensureToken();
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ClientId: this.cfg.clientId,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (response.status === 401 && !isRetry) {
      this.token = undefined;
      return this.request<T>(method, path, opts, true);
    }
    if (!response.ok) {
      let message = `${response.status} ${response.statusText} for ${path}`;
      let details: unknown;
      try {
        const body = (await response.json()) as { Message?: string; message?: string };
        message = body.Message ?? body.message ?? message;
        details = body;
      } catch {
        // keep status line message
      }
      throw new CwApiError(message, response.status, undefined, details);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }
}
