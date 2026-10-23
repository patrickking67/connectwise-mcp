import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";

const CONFIG: AppConfig = {
  port: 8080,
  psa: {
    site: "api-na.myconnectwise.net",
    companyId: "mycompany",
    publicKey: "pub",
    privateKey: "priv",
    clientId: "guid",
  },
  // The write tests below exercise the tools themselves, so PSA writes are on;
  // test/gate.test.ts covers the gate closed.
  gates: { psa: { write: true, destructive: true } },
};

async function connect(config: AppConfig, fetchImpl: typeof fetch) {
  const server = createServer(config, { fetchImpl, sleep: async () => {} });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("connectwise MCP server", () => {
  it("registers the PSA tool surface", async () => {
    const client = await connect(CONFIG, vi.fn());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const expected of [
      "cw_search_tickets",
      "cw_get_ticket",
      "cw_create_ticket",
      "cw_update_ticket",
      "cw_add_ticket_note",
      "cw_search_companies",
      "cw_search_configurations",
      "cw_create_time_entry",
      "cw_list_boards",
      "cw_get_board_info",
      "cw_api_get",
      "cw_status_system",
      "cw_search_project_tickets",
      "cw_search_purchase_orders",
      "cw_search_expenses",
      "cw_create_expense",
      "cw_get_agreement_additions",
      "cw_get_ticket_tasks",
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.some((n) => n.startsWith("cw_automate_"))).toBe(false);

    const search = tools.find((t) => t.name === "cw_search_tickets");
    expect(search?.annotations?.readOnlyHint).toBe(true);
  });

  it("registers automate tools only when configured", async () => {
    const client = await connect(
      {
        ...CONFIG,
        automate: {
          baseUrl: "https://automate.example.com",
          username: "u",
          password: "p",
          clientId: "guid",
        },
      },
      vi.fn(),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("cw_automate_search_computers");
  });

  it("searches tickets with default compact fields and strips nulls", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        [{ id: 1, summary: "VPN down", board: { name: "Help Desk" }, contact: null }],
        { link: '<next>; rel="next"' },
      ),
    );
    const client = await connect(CONFIG, fetchImpl);

    const result = await client.callTool({
      name: "cw_search_tickets",
      arguments: { conditions: 'closedFlag=false', pageSize: 10 },
    });

    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toContain("/service/tickets");
    expect(url.searchParams.get("fields")).toContain("id,summary");

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text);
    expect(payload.count).toBe(1);
    expect(payload.hasMore).toBe(true);
    expect(payload.items[0]).toEqual({ id: 1, summary: "VPN down", board: { name: "Help Desk" } });
  });

  it("returns full records when fields=all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = await connect(CONFIG, fetchImpl);
    await client.callTool({ name: "cw_search_tickets", arguments: { fields: "all" } });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("fields")).toBeNull();
  });

  it("updates a ticket via PATCH ops", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 42, summary: "x" }));
    const client = await connect(CONFIG, fetchImpl);

    await client.callTool({
      name: "cw_update_ticket",
      arguments: { id: 42, updates: { status: { name: "In Progress" } }, confirm: true },
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/service/tickets/42");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual([
      { op: "replace", path: "status", value: { name: "In Progress" } },
    ]);
  });

  it("surfaces API errors as tool errors, not protocol failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "Security", message: "SSL is required." }), { status: 403 }),
    );
    const client = await connect(CONFIG, fetchImpl);

    const result = await client.callTool({
      name: "cw_search_tickets",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("SSL is required.");
    expect(text).toContain("403");
  });

  it("refuses DELETE via cw_api_write without confirm", async () => {
    const fetchImpl = vi.fn();
    const client = await connect(CONFIG, fetchImpl);

    const result = await client.callTool({
      name: "cw_api_write",
      arguments: { method: "DELETE", path: "/service/tickets/1" },
      // confirm omitted: the gate refuses before anything is sent.
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the raw read escape hatch on GET", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ id: 1 }]));
    const client = await connect(CONFIG, fetchImpl);

    await client.callTool({ name: "cw_api_get", arguments: { path: "/service/priorities" } });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/service/priorities");
    expect(init.method).toBe("GET");
  });

  it("requires a company reference when creating tickets", async () => {
    const fetchImpl = vi.fn();
    const client = await connect(CONFIG, fetchImpl);
    const result = await client.callTool({
      name: "cw_create_ticket",
      arguments: { summary: "Broken printer", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
