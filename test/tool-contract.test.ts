import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { TOOL_CATALOG, TOOL_SPECS } from "../src/tools/catalog.js";
import {
  READ_VERBS,
  TOOL_NAME_PATTERN,
  VIEW_VERB,
  WRITE_VERBS,
  titleFromName,
  toolTitle,
  toolVerb,
} from "../src/tools/spec.js";
import { TICKET_CARD_URI, VIEW_MIME_TYPE } from "../src/apps/index.js";

/** Every module configured, so the server registers the whole catalog. */
const FULL_CONFIG: AppConfig = {
  port: 8080,
  psa: {
    site: "api-na.myconnectwise.net",
    companyId: "mycompany",
    publicKey: "pub",
    privateKey: "priv",
    clientId: "guid",
  },
  automate: {
    baseUrl: "https://automate.example.com",
    username: "u",
    password: "p",
    clientId: "guid",
  },
  screenconnect: { baseUrl: "https://x.screenconnect.com", username: "u", password: "p" },
};

async function connectFull() {
  const server = createServer(FULL_CONFIG, { fetchImpl: vi.fn(), sleep: async () => {} });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("tool naming", () => {
  it("derives the display title from the wire name", () => {
    expect(titleFromName("cw_list_catalog_categories")).toBe("List Catalog Categories");
    expect(titleFromName("cw_api_get")).toBe("API Get");
    expect(titleFromName("cw_get_ticket")).toBe("Get Ticket");
  });

  it("names every tool cw_ + snake_case", () => {
    for (const spec of TOOL_SPECS) {
      expect(spec.name, spec.name).toMatch(TOOL_NAME_PATTERN);
    }
  });

  it("gives every tool a Title Case display name", () => {
    for (const spec of TOOL_SPECS) {
      // Every word starts uppercase; short connectives may stay lowercase.
      expect(toolTitle(spec), spec.name).toMatch(/^[A-Z][A-Za-z0-9]*(?: [A-Za-z0-9()/-]+)*$/);
    }
  });

  it("uses a house verb that matches the tool's kind", () => {
    for (const spec of TOOL_SPECS) {
      const verb = toolVerb(spec.name);
      if (spec.ui && verb === VIEW_VERB) {
        // A view is a read underneath; `view` is only allowed on one.
        expect(spec.kind, spec.name).toBe("read");
        continue;
      }
      const allowed: readonly string[] = spec.kind === "read" ? READ_VERBS : WRITE_VERBS;
      expect(allowed, `${spec.name} (${spec.kind})`).toContain(verb);
    }
  });

  it("names every view cw_[product_]view_<noun> and gives it a ui:// resource", () => {
    for (const spec of TOOL_SPECS) {
      if (!spec.name.includes("_view_")) continue;
      expect(toolVerb(spec.name), spec.name).toBe(VIEW_VERB);
      expect(spec.kind, spec.name).toBe("read");
      expect(spec.ui, spec.name).toMatch(/^ui:\/\/connectwise\//);
    }
  });

  it("has no duplicate names or titles", () => {
    const names = TOOL_SPECS.map((spec) => spec.name);
    const titles = TOOL_SPECS.map(toolTitle);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("advertised tool surface", () => {
  it("registers exactly the catalog, in catalog order", async () => {
    const client = await connectFull();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_CATALOG.map((entry) => entry.name));
  });

  it("sends the display title in both places clients read it", async () => {
    const client = await connectFull();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      const expected = TOOL_CATALOG.find((entry) => entry.name === tool.name)?.title;
      expect(tool.title, tool.name).toBe(expected);
      expect(tool.annotations?.title, tool.name).toBe(expected);
    }
  });

  it("annotates every tool as read-only or as a write", async () => {
    const client = await connectFull();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      const entry = TOOL_CATALOG.find((candidate) => candidate.name === tool.name);
      expect(entry, tool.name).toBeDefined();
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);

      if (entry?.category === "write") {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
        expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
      } else {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
        expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      }
    }
  });

  it("marks the raw write escape hatches as needing a person every time", async () => {
    const client = await connectFull();
    const { tools } = await client.listTools();

    for (const name of ["cw_api_write", "cw_automate_api_write"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?._meta?.["anthropic/requiresUserInteraction"], name).toBe(true);
    }
    // Reads must never carry it — it would turn every lookup into a prompt.
    const read = tools.find((tool) => tool.name === "cw_search_tickets");
    expect(read?._meta?.["anthropic/requiresUserInteraction"]).toBeUndefined();
  });
});

describe("interactive surface", () => {
  it("points cw_get_ticket at the ticket card under both keys", async () => {
    const client = await connectFull();
    const { tools } = await client.listTools();
    const ticket = tools.find((tool) => tool.name === "cw_get_ticket");

    expect((ticket?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(TICKET_CARD_URI);
    expect(ticket?._meta?.["openai/outputTemplate"]).toBe(TICKET_CARD_URI);
    // Interactive is a presentation choice; reading a ticket is still read-only.
    expect(ticket?.annotations?.readOnlyHint).toBe(true);
  });

  it("lets the card call back into the note tool", async () => {
    const client = await connectFull();
    const { tools } = await client.listTools();
    const note = tools.find((tool) => tool.name === "cw_add_ticket_note");

    expect((note?._meta?.ui as { visibility?: string[] })?.visibility).toContain("app");
    expect(note?._meta?.["openai/widgetAccessible"]).toBe(true);
    // A tool the card cannot reach must not claim it can.
    const search = tools.find((tool) => tool.name === "cw_search_tickets");
    expect(search?._meta?.["openai/widgetAccessible"]).toBeUndefined();
  });

  it("serves the card as a predeclared MCP Apps resource", async () => {
    const client = await connectFull();
    const { resources } = await client.listResources();
    const card = resources.find((resource) => resource.uri === TICKET_CARD_URI);
    expect(card?.mimeType).toBe(VIEW_MIME_TYPE);

    const read = await client.readResource({ uri: TICKET_CARD_URI });
    const contents = read.contents[0] as { mimeType?: string; text?: string };
    expect(contents.mimeType).toBe(VIEW_MIME_TYPE);
    expect(contents.text).toContain("<!doctype html>");
    // The card calls back into the note tool by name; keep the two in step.
    expect(contents.text).toContain("cw_add_ticket_note");
  });

  it("returns structuredContent for the card and the same JSON for everyone else", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 7, summary: "VPN down", contact: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1, text: "looking into it" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const server = createServer(FULL_CONFIG, { fetchImpl, sleep: async () => {} });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "cw_get_ticket", arguments: { id: 7 } });
    const text = (result.content as Array<{ text: string }>)[0].text;

    expect(result.structuredContent).toEqual(JSON.parse(text));
    expect((result.structuredContent as { ticket: { summary: string } }).ticket.summary).toBe("VPN down");
  });
});

describe("views", () => {
  const VIEWS = ["cw_get_ticket", "cw_view_board", "cw_view_company", "cw_view_time", "cw_automate_view_computers", "cw_control_view_sessions"];

  it("registers every view as a read tool with a ui:// resource under both keys", async () => {
    const client = await connectFull();
    const { tools } = await client.listTools();
    for (const name of VIEWS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      const uri = (tool?._meta?.ui as { resourceUri?: string })?.resourceUri;
      expect(uri, name).toMatch(/^ui:\/\/connectwise\//);
      expect(tool?._meta?.["openai/outputTemplate"], name).toBe(uri);
      expect(tool?.annotations?.readOnlyHint, name).toBe(true);
    }
  });

  it("serves each view as a self-contained themed HTML document", async () => {
    const client = await connectFull();
    const { resources } = await client.listResources();
    for (const name of VIEWS) {
      const { tools } = await client.listTools();
      const uri = (tools.find((t) => t.name === name)?._meta?.ui as { resourceUri?: string })?.resourceUri!;
      expect(resources.find((r) => r.uri === uri)?.mimeType, name).toBe(VIEW_MIME_TYPE);
      const read = await client.readResource({ uri });
      const text = (read.contents[0] as { text?: string }).text ?? "";
      expect(text, name).toContain("<!doctype html>");
      // Light and dark both have to be right, and nothing may be fetched.
      expect(text, name).toContain("prefers-color-scheme: dark");
      expect(text, name).toContain('data-theme="dark"');
      expect(text, name).not.toMatch(/<script[^>]+src=/);
      expect(text, name).not.toMatch(/https?:\/\/(cdn|unpkg|esm)\./);
    }
  });

  it("registers a product's views only when that product is configured", async () => {
    const psaOnly = createServer({ port: 8080, psa: FULL_CONFIG.psa }, { fetchImpl: vi.fn(), sleep: async () => {} });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([psaOnly.connect(serverTransport), client.connect(clientTransport)]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("cw_view_board");
    expect(names).not.toContain("cw_automate_view_computers");
    expect(names).not.toContain("cw_control_view_sessions");
  });
});

describe("cw_status_server", () => {
  async function connectWith(config: Parameters<typeof createServer>[0], env: NodeJS.ProcessEnv) {
    const server = createServer(config, { fetchImpl: vi.fn(), sleep: async () => {} }, { env });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("is the one tool a server with nothing configured still has", async () => {
    const client = await connectWith({ port: 8080 }, {});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["cw_status_server"]);
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
  });

  it("names the missing variables and their Settings > Extensions fields", async () => {
    const client = await connectWith(
      { port: 8080 },
      { CW_AUTOMATE_URL: "https://rmm.example", CW_AUTOMATE_PASSWORD: "pw", CW_AUTOMATE_CLIENT_ID: "cid" },
    );
    const result = await client.callTool({ name: "cw_status_server", arguments: {} });
    const status = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
      productsConfigured: number;
      products: Array<{ product: string; state?: string; missing?: Array<{ env: string; settingsField: string }> }>;
    };

    expect(status.productsConfigured).toBe(0);
    const automate = status.products.find((p) => p.product.includes("Automate"))!;
    expect(automate.state).toBe("incomplete");
    expect(automate.missing).toEqual([
      { env: "CW_AUTOMATE_USERNAME", settingsField: "Automate username" },
    ]);
    const psa = status.products.find((p) => p.product.includes("PSA"))!;
    expect(psa.state).toBe("not configured");
    expect(psa.missing?.map((v) => v.env)).toContain("CW_PSA_SITE");
  });

  it("reports every product as configured on a fully configured server", async () => {
    const client = await connectWith(FULL_CONFIG, {});
    const result = await client.callTool({ name: "cw_status_server", arguments: {} });
    const status = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
      ok: boolean;
      productsConfigured: number;
      tools: number;
    };
    expect(status.ok).toBe(true);
    expect(status.productsConfigured).toBe(3);
    expect(status.tools).toBe(TOOL_CATALOG.length);
  });
});
