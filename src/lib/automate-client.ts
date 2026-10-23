import type { AutomateConfig } from "../config.js";
import { CwApiError, type ClientDeps, type Query } from "./psa-client.js";
import { looksLikeTwoFactorChallenge, totp } from "./totp.js";

/**
 * Read a field from the apitoken reply without caring about key casing.
 * Automate answers in PascalCase, but proxies and newer builds have been seen
 * camelCasing it, and a missed key here reads as "no token" instead of a login.
 */
function field(body: Record<string, unknown>, ...names: string[]): unknown {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(body)) {
    if (wanted.has(key.toLowerCase())) return value;
  }
  return undefined;
}

/**
 * A 200 from /apitoken without a token is a refusal, not a success. Say why in
 * terms the operator can act on, and never echo anything that could be a secret.
 */
export function describeTokenlessReply(body: Record<string, unknown>, sentPasscode: boolean): string {
  const twoFactor = field(body, "IsTwoFactorRequired", "TwoFactorRequired", "IsTwoFactorRequested");
  if (twoFactor === true || twoFactor === "true") {
    return sentPasscode
      ? "Automate asked for a two-factor passcode and rejected the one generated from CW_AUTOMATE_TOTP_SECRET. Check the seed and the machine clock."
      : "Automate requires two-factor for this account on the API, even if the browser login does not prompt (a trusted device or SSO can hide it). " +
          "Tick Integrator on the Automate user (integrator accounts are exempt from MFA and are meant for API logins), " +
          "or set CW_AUTOMATE_TOTP_SECRET.";
  }
  const message = field(body, "Message", "message", "error", "error_description");
  const keys = Object.keys(body).join(", ") || "(empty body)";
  return (
    "Automate authentication returned no AccessToken" +
    (typeof message === "string" && message ? `: ${message.slice(0, 200)}` : "") +
    ` (reply fields: ${keys})`
  );
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

  /** The configured login name (not a secret; reported by cw_automate_test_connection). */
  get username(): string {
    return this.cfg.username;
  }

  /** The Automate server's base URL. */
  get serverUrl(): string {
    return this.cfg.baseUrl;
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
    const raw = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      throw new CwApiError(
        `Automate token endpoint did not return JSON (got ${response.headers.get("content-type") ?? "no content-type"}); ` +
          `CW_AUTOMATE_URL may point at a login page or proxy instead of the Automate server root`,
        502,
      );
    }
    const accessToken = field(body, "AccessToken", "access_token", "token");
    if (typeof accessToken !== "string" || !accessToken) {
      throw new CwApiError(describeTokenlessReply(body, Boolean(credentials.TwoFactorPasscode)), 401);
    }
    const expiration = field(body, "ExpirationDate", "expires");
    const parsedExpiry = typeof expiration === "string" ? Date.parse(expiration) : NaN;
    const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 30 * 60_000;
    this.token = { value: accessToken, expiresAt };
    return accessToken;
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

  /**
   * One page of an Automate list endpoint. Automate sends no paging headers, so
   * `hasMore` is inferred: a full page means there may be another.
   */
  async list<T = Record<string, unknown>>(path: string, params: AutomateListParams = {}): Promise<AutomateListResult<T>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 25;
    const data = await this.get<unknown>(path, {
      condition: params.condition,
      includefields: params.includeFields,
      orderby: params.orderBy,
      page,
      pagesize: pageSize,
    });
    const items = (Array.isArray(data) ? data : []) as T[];
    return { items, page, pageSize, hasMore: items.length >= pageSize };
  }
}

export interface AutomateListParams {
  condition?: string;
  includeFields?: string;
  orderBy?: string;
  page?: number;
  pageSize?: number;
}

export interface AutomateListResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}
