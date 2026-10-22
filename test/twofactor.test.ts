// Two-factor on the Automate and Control login accounts.
//
// Both products can require a second factor on the account an integration logs
// in as, and both then fail in a way that reads like a wrong password. These
// cases pin the two behaviours that matter: the generated passcode is actually
// sent when a seed is configured, and the error names the missing setting when
// one is not.
//
// Every credential here is synthetic and nothing reaches ConnectWise.

import { describe, expect, it, vi } from "vitest";
import { AutomateClient } from "../src/lib/automate-client.js";
import { ScreenConnectClient } from "../src/lib/screenconnect-client.js";
import { totp } from "../src/lib/totp.js";

const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const AUTOMATE = {
  baseUrl: "https://rmm.example.com",
  username: "Admin",
  password: "mock-password-not-real",
  clientId: "mock-client-id",
};

const CONTROL = {
  baseUrl: "https://helpme.example.com",
  username: "scadm1n2",
  password: "mock-password-not-real",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Automate two-factor", () => {
  it("sends the generated passcode when a seed is configured", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ AccessToken: "tok", ExpirationDate: new Date(Date.now() + 3_600_000).toISOString() }))
      .mockResolvedValueOnce(json([{ Id: 1 }]));
    const client = new AutomateClient({ ...AUTOMATE, totpSecret: SEED }, { fetchImpl });

    await client.get("/Computers");

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string) as Record<string, string>;
    expect(body.UserName).toBe("Admin");
    expect(body.TwoFactorPasscode).toBe(totp(SEED));
  });

  it("sends no passcode when no seed is configured", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ AccessToken: "tok" }))
      .mockResolvedValueOnce(json([]));
    const client = new AutomateClient(AUTOMATE, { fetchImpl });

    await client.get("/Computers");

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string) as Record<string, string>;
    expect(body.TwoFactorPasscode).toBeUndefined();
  });

  it("says two-factor is the problem, and names the setting, instead of 'authentication failed'", async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response("TwoFactorPasscode is required for this user", { status: 401 }));
    const client = new AutomateClient(AUTOMATE, { fetchImpl });

    await expect(client.get("/Computers")).rejects.toThrow(/two-factor authentication enabled/i);
    await expect(client.get("/Computers")).rejects.toThrow(/CW_AUTOMATE_TOTP_SECRET/);
  });

  it("still reports an ordinary bad credential as one", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("Invalid username or password", { status: 401 }));
    const client = new AutomateClient(AUTOMATE, { fetchImpl });

    await expect(client.get("/Computers")).rejects.toThrow(/Invalid username or password/);
  });
});

describe("Control two-factor", () => {
  const session = (body: unknown) =>
    json(body, { headers: { "content-type": "application/json", "set-cookie": ".ASPXAUTH=mock; path=/" } });

  // Control serves the anti-forgery token inline in the login page's context
  // block, and sets no cookie there — so the handshake is: GET /Login, scrape the
  // token, then POST TryLogin with it.
  const loginPage = () =>
    new Response(
      '<script>SC.util.mergeIntoContext({"isUserAuthenticated":false,"antiForgeryToken":"AF-TOKEN-MOCK","x":1});</script>',
      { status: 200, headers: { "content-type": "text/html" } },
    );

  /** TryLogin answers 200 with a SecurityOperationResult number, accepted or not. */
  const verdict = (result: number) => json(result);
  const SUCCESS = 1;
  const ONE_TIME_PASSWORD_REQUIRED = 11;
  const PASSWORD_INVALID = 7;

  const accepted = () =>
    new Response(String(SUCCESS), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": ".ASPXAUTH=mock; path=/" },
    });

  it("sends the generated passcode, and the server's real argument shape", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(loginPage())
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(session([]));
    const client = new ScreenConnectClient({ ...CONTROL, totpSecret: SEED }, { fetchImpl });

    await client.listSessions();

    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toContain("/Services/AuthenticationService.ashx/TryLogin");
    const args = JSON.parse(init.body as string) as unknown[];
    // TryLogin(userName, password, oneTimePassword, shouldTrust, securityNonce)
    expect(args).toHaveLength(5);
    expect(args[0]).toBe("scadm1n2");
    expect(args[2]).toBe(totp(SEED));
    // shouldTrust must be a real Boolean: a string here is what made .NET refuse
    // to bind the arguments and throw before checking the password.
    expect(args[3]).toBe(false);
    expect(typeof args[4]).toBe("string");
    expect((args[4] as string)).toHaveLength(16);
  });

  it("echoes the anti-forgery token it scraped from the login page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(loginPage())
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(session([]));
    const client = new ScreenConnectClient({ ...CONTROL, totpSecret: SEED }, { fetchImpl });

    await client.listSessions();

    const headers = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Anti-Forgery-Token"]).toBe("AF-TOKEN-MOCK");
  });

  it("retries with a passcode when the first attempt is challenged", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(loginPage())
      .mockResolvedValueOnce(verdict(ONE_TIME_PASSWORD_REQUIRED))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(session([]));
    const client = new ScreenConnectClient({ ...CONTROL, totpSecret: SEED }, { fetchImpl });

    await client.listSessions();

    expect(JSON.parse(fetchImpl.mock.calls[2][1].body as string)[2]).toBe(totp(SEED));
  });

  it("says two-factor is the problem, and names the setting, when no seed is configured", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      String(url).includes("TryLogin") ? verdict(ONE_TIME_PASSWORD_REQUIRED) : loginPage(),
    );
    const client = new ScreenConnectClient(CONTROL, { fetchImpl });

    await expect(client.listSessions()).rejects.toThrow(/two-factor authentication enabled/i);
    await expect(client.listSessions()).rejects.toThrow(/CW_SCREENCONNECT_TOTP_SECRET/);
  });

  it("reports a refusal carried in a 200 body as a refusal, not a success", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      String(url).includes("TryLogin") ? verdict(PASSWORD_INVALID) : loginPage(),
    );
    const client = new ScreenConnectClient(CONTROL, { fetchImpl });

    await expect(client.listSessions()).rejects.toThrow(/login refused: PasswordInvalid/);
  });

  it("still reports an ordinary login failure as one", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
      String(url).includes("TryLogin") ? new Response("Login failed", { status: 401 }) : loginPage(),
    );
    const client = new ScreenConnectClient(CONTROL, { fetchImpl });

    await expect(client.listSessions()).rejects.toThrow(/ScreenConnect login failed \(401/);
  });
});
