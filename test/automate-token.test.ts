// Automate /apitoken replies that are 200 but carry no token.
// Every credential here is synthetic and nothing reaches ConnectWise.

import { describe, expect, it, vi } from "vitest";
import { AutomateClient } from "../src/lib/automate-client.js";

const AUTOMATE = {
  baseUrl: "https://rmm.example.com",
  username: "svc-api",
  password: "mock-password-not-real",
  clientId: "mock-client-id",
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Automate token reply", () => {
  it("accepts a camelCase token", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ accessToken: "tok" })).mockResolvedValueOnce(json([]));
    await new AutomateClient(AUTOMATE, { fetchImpl }).get("/Computers");
    const headers = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("names two-factor and the Integrator fix when a 200 demands it", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({ AccessToken: null, IsTwoFactorRequired: true }));
    const client = new AutomateClient(AUTOMATE, { fetchImpl });
    await expect(client.get("/Computers")).rejects.toThrow(/Tick Integrator/);
  });

  it("surfaces the server message and reply fields instead of a bare 'no AccessToken'", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({ Message: "User is locked out", AccessToken: null }));
    const client = new AutomateClient(AUTOMATE, { fetchImpl });
    await expect(client.get("/Computers")).rejects.toThrow(/User is locked out.*reply fields: Message, AccessToken/);
  });

  it("calls out an HTML login page instead of JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const client = new AutomateClient(AUTOMATE, { fetchImpl });
    await expect(client.get("/Computers")).rejects.toThrow(/did not return JSON/);
  });
});
