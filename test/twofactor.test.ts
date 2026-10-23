// Two-factor on the Automate login account.
//
// Automate can require a second factor on the account an integration logs in
// as, and then fails in a way that reads like a wrong password. These
// cases pin the two behaviours that matter: the generated passcode is actually
// sent when a seed is configured, and the error names the missing setting when
// one is not.
//
// Every credential here is synthetic and nothing reaches ConnectWise.

import { describe, expect, it, vi } from "vitest";
import { AutomateClient } from "../src/lib/automate-client.js";
import { totp } from "../src/lib/totp.js";

const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const AUTOMATE = {
  baseUrl: "https://rmm.example.com",
  username: "Admin",
  password: "mock-password-not-real",
  clientId: "mock-client-id",
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
