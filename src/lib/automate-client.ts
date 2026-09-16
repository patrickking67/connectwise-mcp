import type { AutomateConfig } from "../config.js";
import { CwApiError, type ClientDeps, type Query } from "./psa-client.js";

interface TokenResponse {
  AccessToken?: string;
  ExpirationDate?: string;
}

/**
 * Minimal ConnectWise Automate REST client.
 * Auth: POST /cwa/api/v1/apitoken with username/password, then Bearer token.
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
    const response = await this.fetchImpl(`${this.apiBase}/apitoken`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ClientId: this.cfg.clientId,
      },
      body: JSON.stringify({ UserName: this.cfg.username, Password: this.cfg.password }),
    });
    if (!response.ok) {
      // 405 from the token endpoint means the path is wrong, not the credentials:
      // the base URL is pointing somewhere other than the Automate server root.
      const hint =
        response.status === 405
          ? ` — the token endpoint did not accept POST at ${this.apiBase}/apitoken, so CW_AUTOMATE_URL is not the Automate server root; use https://<host> with no path`
          : "";
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
