// The Automate Worker entry point (src/worker/automate.ts), exercised in plain
// Node under vitest like worker.test.ts. What this proves: with only the Automate
// variables set it serves the Automate tools and none of the PSA ones, it names
// itself connectwise-automate-mcp, and it still fails closed without Access. No
// Automate API is called: tools/list never leaves the Worker.

import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/worker/automate.js";
import type { AccessIdentity } from "../src/worker/access.js";

const SERVICE = "connectwise-automate-mcp";
const ENDPOINT = `https://${SERVICE}.example/mcp`;
const VENDOR_ENV = {
  CW_AUTOMATE_URL: "https://rmm.example.com",
  CW_AUTOMATE_USERNAME: "integrator-not-real",
  CW_AUTOMATE_PASSWORD: "password-not-real",
  CW_AUTOMATE_CLIENT_ID: "client-not-real",
};
const READER: AccessIdentity = { email: "reader@divergeit.com", name: "Read Only", groups: [] };
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function ctxFor(identity: AccessIdentity | undefined) {
  return { access: { aud: "test-aud", getIdentity: async () => identity } };
}

async function rpc(ctx: ReturnType<typeof ctxFor> | undefined, method: string) {
  return worker.fetch(
    new Request(ENDPOINT, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }) }),
    { ...VENDOR_ENV },
    ctx,
  );
}

describe("Automate Worker entry point", () => {
  beforeEach(() => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("CW_") || name.startsWith("MCP_") || name.startsWith("ACCESS_")) delete process.env[name];
    }
  });

  it("names itself in /healthz", async () => {
    const response = await worker.fetch(new Request(`https://${SERVICE}.example/healthz`), {}, undefined);
    const body = (await response.json()) as { service: string; endpoint: string };
    expect(body.service).toBe(SERVICE);
    expect(body.endpoint).toBe(ENDPOINT);
  });

  it("serves the Automate tools and none of the PSA ones", async () => {
    const response = await rpc(ctxFor(READER), "tools/list");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names.some((name) => name.startsWith("cw_automate_"))).toBe(true);
    expect(names.filter((name) => name.startsWith("cw_") && !name.startsWith("cw_automate_") && !/^cw_(status|session)_/.test(name))).toEqual([]);
  });

  it("fails closed with 503 when Access is not in front", async () => {
    const response = await rpc(undefined, "tools/list");
    expect(response.status).toBe(503);
  });
});
