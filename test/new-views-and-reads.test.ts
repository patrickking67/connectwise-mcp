// The views and PSA reads added in 0.5.0, through a real server and a routed
// fetch mock. Nothing reaches ConnectWise.

import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { daysSince } from "../src/apps/views/automate-fleet.js";
import { scheduleWindow } from "../src/apps/views/schedule.js";
import { summarizeProjectTickets } from "../src/lib/project-summary.js";

const PSA = { site: "api-na.myconnectwise.net", companyId: "mock", publicKey: "pub", privateKey: "priv", clientId: "guid" };
const AUTOMATE = { baseUrl: "https://rmm.example.com", username: "u", password: "mock", clientId: "cid" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes "METHOD /path" for both products; Automate paths lose /cwa/api/v1, PSA paths lose the version prefix. */
function router(routes: Record<string, unknown | ((url: URL) => unknown)>) {
  const calls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (url.pathname.endsWith("/apitoken")) return json({ AccessToken: "tok" });
    const path = url.pathname.replace(/^\/cwa\/api\/v1/, "").replace(/^\/v4_6_release\/apis\/3\.0/, "");
    calls.push({ method, path, query: url.searchParams });
    const route = routes[`${method} ${path}`];
    if (route === undefined) return json({ message: `no route ${method} ${path}` }, 404);
    return json(typeof route === "function" ? (route as (u: URL) => unknown)(url) : route);
  });
  return { fetchImpl, calls };
}

async function connect(fetchImpl: typeof fetch) {
  const cfg: AppConfig = { port: 8080, psa: PSA, automate: AUTOMATE };
  const server = createServer(cfg, { fetchImpl, sleep: async () => {} });
  const client = new Client({ name: "views-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  if (result.isError) throw new Error(text);
  // Views send the same JSON as structuredContent and as text.
  if (result.structuredContent) expect(result.structuredContent).toEqual(JSON.parse(text));
  return JSON.parse(text) as Record<string, any>;
}

async function viewHtml(client: Client, name: string): Promise<string> {
  const { tools } = await client.listTools();
  const uri = (tools.find((t) => t.name === name)?._meta?.ui as { resourceUri: string }).resourceUri;
  const read = await client.readResource({ uri });
  return (read.contents[0] as { text: string }).text;
}

const recent = new Date(Date.now() - 60_000).toISOString();
const old = new Date(Date.now() - 45 * 86_400_000).toISOString();

describe("cw_automate_view_fleet", () => {
  it("rolls the estate up into the numbers a technician looks for", async () => {
    const { fetchImpl } = router({
      "GET /Computers": [
        { Id: "1", ComputerName: "DC01", Client: { Id: 1, Name: "Acme" }, Type: "Server", Status: "Offline", RemoteAgentLastContact: old },
        { Id: "2", ComputerName: "PC01", Client: { Id: 1, Name: "Acme" }, Type: "Workstation", Status: "Online", RemoteAgentLastContact: recent, IsRebootNeeded: true, AntivirusDefinitionDate: old },
        { Id: "3", ComputerName: "PC02", Client: { Id: 2, Name: "Beta" }, Type: "Workstation", Status: "Online", RemoteAgentLastContact: recent, AntivirusDefinitionDate: recent },
      ],
      "GET /Alerts": [{ AlertId: 1, AlertDate: recent, Severity: "Error", Source: "Disk", Message: "C: full" }],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_automate_view_fleet");
    expect(out.summary).toMatchObject({ total: 3, online: 2, offline: 1, servers: 1, serversOffline: 1, rebootNeeded: 1, stale: 1, avStale: 1 });
    expect(out.clients.find((c: { name: string }) => c.name === "Acme")).toMatchObject({ total: 2, offline: 1, serversOffline: 1 });
    expect(out.attention.map((a: { name: string }) => a.name).sort()).toEqual(["DC01", "PC01"]);
    expect(out.alerts[0]).toMatchObject({ severity: "Error", message: "C: full" });
  });

  it("treats Automate's 0001-01-01 placeholder as no date", () => {
    expect(daysSince("0001-01-01T00:00:00")).toBeUndefined();
    expect(daysSince(undefined)).toBeUndefined();
    expect(daysSince(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe(3);
  });
});

describe("cw_automate_view_computer", () => {
  it("assembles the detail and wires its buttons to the gated write tools", async () => {
    const { fetchImpl, calls } = router({
      "GET /Computers/9": { Id: "9", ComputerName: "SRV9", Status: "Online", Type: "Server", Client: { Id: 1, Name: "Acme" }, VirusScanner: { Name: "Defender" }, IsRebootNeeded: true },
      "GET /Computers/9/Drives": [{ Letter: "A", Size: 0, FreeSpace: 0 }, { Letter: "C", Size: 100000, FreeSpace: 5000, FileSystem: "NTFS" }],
      "GET /Computers/9/PatchingStats": { OverallCompliance: 97.5 },
      "GET /Computers/9/Alerts": [],
      "GET /Computers/9/ScriptHistory": [{ Name: "Disk Cleanup", Status: "Completed", State: "Success", HistoryDate: recent }],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_automate_view_computer", { id: 9 });
    expect(out.computer).toMatchObject({ name: "SRV9", online: true, rebootNeeded: true, antivirus: "Defender", client: "Acme" });
    expect(out.drives).toEqual([{ letter: "C", size: 100000, free: 5000, fs: "NTFS" }]);
    expect(out.patching.OverallCompliance).toBe(97.5);
    expect(out.scriptHistory[0]).toMatchObject({ name: "Disk Cleanup", state: "Success" });
    // Loading the view is read-only.
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    const html = await viewHtml(client, "cw_automate_view_computer");
    expect(html).toContain("cw_automate_run_script");
    expect(html).toContain("cw_automate_reboot_computer");
    expect(html).toContain("cw_automate_list_scripts");
    expect(html).toContain("confirm: true");
  });

  it("marks exactly the tools its buttons call as reachable from a view", async () => {
    const client = await connect(vi.fn() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    for (const name of ["cw_automate_run_script", "cw_automate_reboot_computer", "cw_automate_list_scripts"]) {
      const tool = tools.find((t) => t.name === name);
      expect((tool?._meta?.ui as { visibility?: string[] })?.visibility, name).toContain("app");
    }
  });
});

describe("cw_automate_view_client", () => {
  it("joins the client's locations to its computers", async () => {
    const { fetchImpl, calls } = router({
      "GET /Clients/4": { Id: 4, Name: "Acme", Locations: [{ Id: 10, Name: "HQ" }, { Id: 11, Name: "Branch" }] },
      "GET /Computers": [
        { Id: "1", ComputerName: "A", Location: { Id: 10, Name: "HQ" }, Type: "Server", Status: "Online", OperatingSystemName: "Windows Server 2022" },
        { Id: "2", ComputerName: "B", Location: { Id: 10, Name: "HQ" }, Type: "Workstation", Status: "Offline", OperatingSystemName: "Windows 11" },
      ],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_automate_view_client", { id: 4 });
    expect(calls.find((c) => c.path === "/Computers")?.query.get("condition")).toBe("Client.Id = 4");
    expect(out.summary).toMatchObject({ total: 2, online: 1, offline: 1, servers: 1, workstations: 1 });
    expect(out.locations).toEqual([
      { id: 10, name: "HQ", computers: 2, offline: 1 },
      { id: 11, name: "Branch", computers: 0, offline: 0 },
    ]);
  });
});

describe("cw_automate_view_computers", () => {
  it("uses the paged list helper and the compact field set", async () => {
    const { fetchImpl, calls } = router({ "GET /Computers": [{ Id: "1", ComputerName: "A", Status: "Online", Client: { Name: "Acme" } }] });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_automate_view_computers", { clientId: 1 });
    expect(calls[0].query.get("condition")).toBe("(Client.Id = 1)");
    expect(calls[0].query.get("pagesize")).toBe("250");
    expect(out.summary).toMatchObject({ total: 1, online: 1 });
  });
});

describe("PSA reads added in 0.5.0", () => {
  it("cw_get_configuration and cw_get_contact read one record each", async () => {
    const { fetchImpl, calls } = router({
      "GET /company/configurations/7": { id: 7, name: "FW01" },
      "GET /company/contacts/4": { id: 4, firstName: "Ann" },
    });
    const client = await connect(fetchImpl);
    expect((await call(client, "cw_get_configuration", { id: 7 })).name).toBe("FW01");
    expect((await call(client, "cw_get_contact", { id: 4 })).firstName).toBe("Ann");
    expect(calls.map((c) => c.path)).toEqual(["/company/configurations/7", "/company/contacts/4"]);
  });

  it("cw_get_project returns phases, team and ticket progress by phase", async () => {
    const { fetchImpl, calls } = router({
      "GET /project/projects/30": { id: 30, name: "Migration" },
      "GET /project/projects/30/phases": [{ id: 1, description: "Design" }],
      "GET /project/projects/30/teamMembers": [{ id: 1, member: { identifier: "pk" } }],
      "GET /project/tickets": [
        { id: 1, phase: { name: "Design" }, closedFlag: true, budgetHours: 2, actualHours: 3 },
        { id: 2, phase: { name: "Design" }, closedFlag: false, budgetHours: 4, actualHours: 1 },
      ],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_get_project", { id: 30 });
    expect(calls.find((c) => c.path === "/project/tickets")?.query.get("conditions")).toBe("project/id=30");
    expect(out.tickets).toEqual({ total: 2, open: 1, closed: 1, byPhase: [{ phase: "Design", open: 1, closed: 1, budgetHours: 6, actualHours: 4 }] });
    expect(out.ticketRows).toBeUndefined();
    expect(out.team).toHaveLength(1);
  });

  it("cw_get_purchase_order counts lines still to receive", async () => {
    const { fetchImpl } = router({
      "GET /procurement/purchaseorders/1": { id: 1, poNumber: "PO-1" },
      "GET /procurement/purchaseorders/1/lineitems": [
        { id: 1, quantity: 2, receivedQuantity: 2 },
        { id: 2, quantity: 5, receivedQuantity: 1 },
        { id: 3, quantity: 1, receivedQuantity: 0, canceledFlag: true },
      ],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_get_purchase_order", { id: 1 });
    expect(out.summary).toEqual({ lines: 3, outstanding: 1 });
  });

  it.each([
    ["cw_search_catalog_items", "/procurement/catalog", "manufacturerPartNumber"],
    ["cw_search_products", "/procurement/products", "needToPurchaseFlag"],
  ])("%s searches %s with a compact default field set", async (name, path, field) => {
    const { fetchImpl, calls } = router({ [`GET ${path}`]: [] });
    const client = await connect(fetchImpl);
    await call(client, name, { conditions: "inactiveFlag=false" });
    expect(calls[0].path).toBe(path);
    expect(calls[0].query.get("fields")).toContain(field);
  });

  it("summarizes tickets without a phase under one bucket", () => {
    expect(summarizeProjectTickets([{ closedFlag: false }]).byPhase[0].phase).toBe("(no phase)");
  });
});

describe("cw_view_project and cw_view_schedule", () => {
  it("cw_view_project matches phases to their ticket counts", async () => {
    const { fetchImpl } = router({
      "GET /project/projects/30": { id: 30, name: "Migration", status: { name: "Open" }, budgetHours: 10, actualHours: 12 },
      "GET /project/projects/30/phases": [{ id: 1, description: "Design", wbsCode: "1" }],
      "GET /project/projects/30/teamMembers": [],
      "GET /project/tickets": [{ id: 1, summary: "Plan", phase: { name: "Design" }, closedFlag: false }],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_view_project", { id: 30 });
    expect(out.project).toMatchObject({ name: "Migration", status: "Open", budgetHours: 10, actualHours: 12 });
    expect(out.phases[0]).toMatchObject({ name: "Design", open: 1, closed: 0 });
    expect(out.tickets[0]).toMatchObject({ summary: "Plan", phase: "Design", closed: false });
  });

  it("cw_view_schedule defaults to the next seven days, hides done entries, and totals hours", async () => {
    const { fetchImpl, calls } = router({
      "GET /schedule/entries": [
        { id: 1, name: "Onsite", member: { identifier: "pk" }, dateStart: "2026-10-23T16:00:00Z", dateEnd: "2026-10-23T18:00:00Z" },
        { id: 2, name: "Call", member: { identifier: "jd" }, dateStart: "2026-10-24T16:00:00Z", hours: 0.5 },
      ],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_view_schedule");
    const conditions = calls[0].query.get("conditions") ?? "";
    expect(conditions).toContain("doneFlag=false");
    expect(conditions).toMatch(/dateStart >= \[.*\] and dateStart < \[.*\]/);
    expect(out.totalHours).toBe(2.5);
    expect(out.members.map((m: { member: string }) => m.member).sort()).toEqual(["jd", "pk"]);
    expect(out.days).toHaveLength(2);
  });

  it("computes the default window from midnight UTC", () => {
    const { from, to } = scheduleWindow(new Date("2026-10-22T15:30:00Z"), 7);
    expect(from.toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });
});
