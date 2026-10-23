// The Worker entry point, exercised in plain Node under vitest.
//
// src/worker/*.ts uses only the standard Request/Response types, so the handler
// can be called directly here with a fake ExecutionContext and no Cloudflare
// runtime. What this proves: the Worker fails closed without Access, reads the
// identity Access provides, narrows the tool list to the caller's tier, refuses
// a call above that tier, and logs every call as one JSON line. No ConnectWise
// API is called: tools/list and the refusal path never leave the Worker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index.js";
import type { AccessIdentity } from "../src/worker/access.js";

const SERVICE = "connectwise-psa-mcp";
const PREFIX = "cw";
const ENDPOINT = `https://${SERVICE}.example/mcp`;
const VENDOR_ENV = {
  CW_PSA_SITE: "api-na.myconnectwise.net",
  CW_PSA_COMPANY_ID: "testco",
  CW_PSA_PUBLIC_KEY: "pub-not-real",
  CW_PSA_PRIVATE_KEY: "priv-not-real",
  CW_PSA_CLIENT_ID: "client-not-real",
};

type Identity = AccessIdentity;
const READER: Identity = { email: "reader@divergeit.com", name: "Read Only", groups: [] };
const WRITER: Identity = { email: "writer@divergeit.com", name: "Writer", groups: [{ id: "g1", name: "MCP Operators" }] };
const ADMIN: Identity = { email: "admin@divergeit.com", name: "Admin", groups: [] };

function ctxFor(identity: Identity | undefined) {
  return { access: { aud: "test-aud", getIdentity: async () => identity } };
}

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

interface Tool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema?: { required?: string[]; properties?: Record<string, { type?: string | string[]; enum?: unknown[]; const?: unknown }> };
}

/** Arguments that satisfy the required properties, so the call reaches the handler and its refusal. */
function argsFor(schema: Tool["inputSchema"]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const name of schema?.required ?? []) {
    const prop = schema?.properties?.[name] ?? {};
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    if (Array.isArray(prop.enum) && prop.enum.length > 0) args[name] = prop.enum[0];
    else if (prop.const !== undefined) args[name] = prop.const;
    else if (type === "number" || type === "integer") args[name] = 1;
    else if (type === "boolean") args[name] = true;
    else if (type === "array") args[name] = [];
    else if (type === "object") args[name] = {};
    else args[name] = "x";
  }
  return args;
}

async function rpc(env: Record<string, string>, ctx: ReturnType<typeof ctxFor> | undefined, method: string, params: unknown = {}) {
  return worker.fetch(
    new Request(ENDPOINT, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
    { ...VENDOR_ENV, ...env },
    ctx,
  );
}

async function listTools(env: Record<string, string>, ctx: ReturnType<typeof ctxFor>): Promise<Tool[]> {
  const response = await rpc(env, ctx, "tools/list");
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { result?: { tools?: Tool[] } };
  expect(Array.isArray(body.result?.tools)).toBe(true);
  return body.result!.tools!;
}

function tierOf(tool: Tool): "read" | "write" | "destructive" {
  if (tool.annotations?.destructiveHint === true) return "destructive";
  if (tool.annotations?.readOnlyHint === true) return "read";
  return "write";
}

describe("Worker entry point", () => {
  beforeEach(() => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("CW_") || name.startsWith("MCP_") || name.startsWith("ACCESS_")) delete process.env[name];
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers /healthz without authentication", async () => {
    const response = await worker.fetch(new Request(`https://${SERVICE}.example/healthz`), {}, undefined);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; service: string; endpoint: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe(SERVICE);
    expect(body.endpoint).toBe(ENDPOINT);
  });

  it("serves only POST /mcp", async () => {
    const get = await worker.fetch(new Request(ENDPOINT, { method: "GET" }), {}, ctxFor(READER));
    expect(get.status).toBe(405);
    const elsewhere = await worker.fetch(new Request(`https://${SERVICE}.example/x`, { method: "POST" }), {}, ctxFor(READER));
    expect(elsewhere.status).toBe(404);
  });

  it("treats the bare hostname as an alias for /mcp, for connectors saved without the path", async () => {
    const root = `https://${SERVICE}.example/`;
    const listed = await worker.fetch(
      new Request(root, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }),
      { ...VENDOR_ENV },
      ctxFor(READER),
    );
    expect(listed.status, await listed.clone().text()).toBe(200);
    const get = await worker.fetch(new Request(root, { method: "GET" }), {}, ctxFor(READER));
    expect(get.status).toBe(405);
  });

  it("fails closed with 503 when Access is not in front", async () => {
    const response = await rpc({}, undefined, "tools/list");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("not_behind_access");
  });

  it("answers 401 when the Access binding authenticated nobody", async () => {
    const response = await rpc({}, ctxFor(undefined), "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(new RegExp(`^Bearer realm="${SERVICE}"`));
  });

  it("shows a read-only caller only read tools plus the session status tool", async () => {
    const everything = await listTools({ MCP_DESTRUCTIVE_PRINCIPALS: ADMIN.email }, ctxFor(ADMIN));
    const readOnly = await listTools({}, ctxFor(READER));
    const expected = everything.filter((tool) => tierOf(tool) === "read").map((tool) => tool.name).sort();
    expect(readOnly.map((tool) => tool.name).sort()).toEqual(expected);
    expect(readOnly.some((tool) => tool.name === `${PREFIX}_session_status`)).toBe(true);
    expect(everything.length).toBeGreaterThan(readOnly.length);
  });

  it("nests tiers and grants write by group", async () => {
    const everything = await listTools({ MCP_DESTRUCTIVE_PRINCIPALS: ADMIN.email }, ctxFor(ADMIN));
    const asWriter = await listTools({ MCP_WRITE_PRINCIPALS: "group:mcp operators" }, ctxFor(WRITER));
    const asReader = await listTools({ MCP_WRITE_PRINCIPALS: "group:mcp operators" }, ctxFor(READER));
    const all = new Set(everything.map((t) => t.name));
    const write = new Set(asWriter.map((t) => t.name));
    for (const tool of asReader) expect(write.has(tool.name)).toBe(true);
    for (const tool of asWriter) {
      expect(all.has(tool.name)).toBe(true);
      expect(tierOf(tool)).not.toBe("destructive");
    }
    const destructiveCount = everything.filter((tool) => tierOf(tool) === "destructive").length;
    expect(all.size - write.size).toBe(destructiveCount);
    expect(destructiveCount).toBeGreaterThan(0);
  });

  it("turns deny-by-default on with MCP_READ_PRINCIPALS", async () => {
    expect((await rpc({ MCP_READ_PRINCIPALS: "someone-else@divergeit.com" }, ctxFor(READER), "tools/list")).status).toBe(403);
    expect((await rpc({ MCP_READ_PRINCIPALS: "@divergeit.com" }, ctxFor(READER), "tools/list")).status).toBe(200);
  });

  it("reports the session through the status tool", async () => {
    const response = await rpc({}, ctxFor(READER), "tools/call", { name: `${PREFIX}_session_status`, arguments: {} });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { isError?: boolean; structuredContent: Record<string, any> } };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.user.email).toBe(READER.email);
    expect(body.result.structuredContent.tier).toBe("read");
    expect(body.result.structuredContent.tools.hidden.read).toBe(0);
  });

  it("refuses a call above the caller tier with the var to change, and logs it", async () => {
    const everything = await listTools({ MCP_DESTRUCTIVE_PRINCIPALS: ADMIN.email }, ctxFor(ADMIN));
    const target = everything.find((tool) => tierOf(tool) !== "read")!;
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const response = await rpc({ MCP_HIDE_UNENTITLED_TOOLS: "false" }, ctxFor(READER), "tools/call", { name: target.name, arguments: argsFor(target.inputSchema) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/Refused/);
    expect(body.result.content[0]!.text).toMatch(/MCP_(WRITE|DESTRUCTIVE)_PRINCIPALS/);
    const audit = lines
      .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } })
      .filter((entry) => entry?.event === "mcp.tool_call");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.outcome).toBe("refused");
    expect(audit[0]!.user).toBe(READER.email);
  });
});
