// The write gate, end to end through a real server.
//
// Three checks stand between a model and a change: <PREFIX>_MODE=write, the
// ALLOW_DESTRUCTIVE switch for the disruptive tier, and confirm: true on the
// call. Each refusal must happen before any request leaves the process, and
// must name the setting that would allow it. Nothing here reaches ConnectWise.

import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { AppConfig, WriteGate } from "../src/config.js";
import { TOOL_SPECS } from "../src/tools/catalog.js";

const PSA = {
  site: "api-na.myconnectwise.net",
  companyId: "mock",
  publicKey: "pub",
  privateKey: "priv",
  clientId: "guid",
};
const AUTOMATE = { baseUrl: "https://rmm.example.com", username: "u", password: "p", clientId: "cid" };

function config(gates: { psa?: WriteGate; automate?: WriteGate } = {}): AppConfig {
  return { port: 8080, psa: PSA, automate: AUTOMATE, gates };
}

async function connect(cfg: AppConfig, fetchImpl = vi.fn()) {
  const server = createServer(cfg, { fetchImpl, sleep: async () => {} });
  const client = new Client({ name: "gate-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, fetchImpl };
}

function text(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0]?.text ?? "") as string;
}

const OPEN: WriteGate = { write: true, destructive: false };
const WIDE: WriteGate = { write: true, destructive: true };

describe("write tools in read mode", () => {
  it("are still listed", async () => {
    const { client } = await connect(config());
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const spec of TOOL_SPECS.filter((s) => s.kind === "write")) {
      expect(names, spec.name).toContain(spec.name);
    }
  });

  it("every one carries a confirm parameter", async () => {
    const { client } = await connect(config());
    const { tools } = await client.listTools();
    for (const spec of TOOL_SPECS.filter((s) => s.kind === "write")) {
      const tool = tools.find((t) => t.name === spec.name);
      const props = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props, spec.name).toHaveProperty("confirm");
    }
  });

  it.each([
    ["cw_add_ticket_note", { ticketId: 1, text: "hi", confirm: true }, "CW_PSA_MODE=write", "PSA write mode"],
    ["cw_update_ticket", { id: 1, updates: { summary: "x" }, confirm: true }, "CW_PSA_MODE=write", "PSA write mode"],
    ["cw_automate_run_script", { computerIds: [1], scriptId: 2, confirm: true }, "CW_AUTOMATE_MODE=write", "Automate write mode"],
    ["cw_automate_run_shell_command", { computerId: 1, command: "ipconfig", confirm: true }, "CW_AUTOMATE_MODE=write", "Automate write mode"],
    ["cw_automate_reboot_computer", { computerId: 1, confirm: true }, "CW_AUTOMATE_MODE=write", "Automate write mode"],
  ])("%s refuses, names the setting, and sends nothing", async (name, args, envVar, field) => {
    const { client, fetchImpl } = await connect(config());
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(envVar);
    expect(text(result)).toContain(field);
    expect(text(result)).toContain("Nothing was changed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the products separate: PSA write mode does not open Automate", async () => {
    const { client, fetchImpl } = await connect(config({ psa: WIDE }));
    const result = await client.callTool({ name: "cw_automate_run_script", arguments: { computerIds: [1], scriptId: 2, confirm: true } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("CW_AUTOMATE_MODE=write");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the disruptive tier", () => {
  it.each([
    ["cw_automate_reboot_computer", { computerId: 1, confirm: true }],
    ["cw_automate_delete_script_schedule", { scheduleId: 5, confirm: true }],
    ["cw_automate_uninstall_software", { computerId: 1, softwareId: 9, confirm: true }],
    ["cw_automate_api_write", { method: "POST", path: "/Computers/1/CommandExecute", body: {}, confirm: true }],
  ])("%s needs CW_AUTOMATE_ALLOW_DESTRUCTIVE on top of write mode", async (name, args) => {
    const { client, fetchImpl } = await connect(config({ automate: OPEN }));
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("CW_AUTOMATE_ALLOW_DESTRUCTIVE=true");
    expect(text(result)).toContain("Automate allow destructive");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cw_api_write needs CW_PSA_ALLOW_DESTRUCTIVE", async () => {
    const { client, fetchImpl } = await connect(config({ psa: OPEN }));
    const result = await client.callTool({
      name: "cw_api_write",
      arguments: { method: "POST", path: "/service/tickets", body: {}, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("CW_PSA_ALLOW_DESTRUCTIVE=true");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is exactly the tools annotated destructiveHint", async () => {
    const { client } = await connect(config());
    const { tools } = await client.listTools();
    const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name).sort();
    expect(destructive).toEqual(
      [
        "cw_api_write",
        "cw_automate_api_write",
        "cw_automate_delete_script_schedule",
        "cw_automate_reboot_computer",
        "cw_automate_uninstall_software",
      ].sort(),
    );
  });
});

describe("confirm", () => {
  it("is required even with every gate open", async () => {
    const { client, fetchImpl } = await connect(config({ psa: WIDE, automate: WIDE }));
    for (const [name, args] of [
      ["cw_add_ticket_note", { ticketId: 1, text: "hi" }],
      ["cw_automate_run_script", { computerIds: [1], scriptId: 2 }],
      ["cw_automate_reboot_computer", { computerId: 1, confirm: false }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
      expect(text(result), name).toContain("confirm: true");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("cw_status_gate", () => {
  it("reports each product's gate, its env vars and its Settings fields", async () => {
    const { client, fetchImpl } = await connect(config({ psa: OPEN }));
    const result = await client.callTool({ name: "cw_status_gate", arguments: {} });
    const report = JSON.parse(text(result)) as {
      products: Array<{ product: string; mode: string; destructiveAllowed: boolean; modeEnvVar: string; modeSettingsField: string }>;
    };
    const psa = report.products.find((p) => p.product.includes("PSA"))!;
    const automate = report.products.find((p) => p.product.includes("Automate"))!;
    expect(psa).toMatchObject({ mode: "write", destructiveAllowed: false, modeEnvVar: "CW_PSA_MODE", modeSettingsField: "PSA write mode" });
    expect(automate).toMatchObject({ mode: "read", destructiveAllowed: false, modeEnvVar: "CW_AUTOMATE_MODE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is registered with nothing configured and reports everything closed", async () => {
    const { client } = await connect({ port: 8080 });
    const result = await client.callTool({ name: "cw_status_gate", arguments: {} });
    const report = JSON.parse(text(result)) as { products: Array<{ mode: string }> };
    expect(report.products.every((p) => p.mode === "read")).toBe(true);
  });
});
