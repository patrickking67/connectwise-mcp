// Every Automate tool, through a real server, against a routed fetch mock.
//
// Reads are checked for the path and query they send and the shape they
// return; writes for the exact method, path and body they would send with the
// gate open (and nothing sent when it is closed — see gate.test.ts). No test
// reaches an Automate server: the token call and every API call are mocked.

import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { AppConfig, WriteGate } from "../src/config.js";
import { AUTOMATE_TOOL_SPECS, DISRUPTIVE_COMMAND } from "../src/tools/automate.js";
import { AUTOMATE_VIEW_SPECS } from "../src/apps/index.js";

const AUTOMATE = { baseUrl: "https://rmm.example.com", username: "api-user", password: "mock", clientId: "cid" };

type Route = (url: URL, init: RequestInit) => unknown;

/** A fetch that answers the token call, then routes "METHOD /path" to a handler. */
function router(routes: Record<string, Route | unknown>) {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (url.pathname.endsWith("/apitoken")) {
      return json({ AccessToken: "tok", ExpirationDate: new Date(Date.now() + 3_600_000).toISOString() });
    }
    const path = url.pathname.replace(/^\/cwa\/api\/v1/, "");
    calls.push({ method, path, query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (!(key in routes)) return json({ Message: `no route ${key}` }, 404);
    const route = routes[key];
    return json(typeof route === "function" ? (route as Route)(url, init) : route);
  });
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function connect(fetchImpl: typeof fetch, gate?: WriteGate) {
  const cfg: AppConfig = { port: 8080, automate: AUTOMATE, gates: gate ? { automate: gate } : {} };
  const server = createServer(cfg, { fetchImpl, sleep: async () => {} });
  const client = new Client({ name: "automate-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as Record<string, any>;
}

const WRITE: WriteGate = { write: true, destructive: false };
const WIDE: WriteGate = { write: true, destructive: true };

describe("Automate tool surface", () => {
  it("registers every Automate tool and view with read-only reads", async () => {
    const client = await connect(vi.fn() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    for (const spec of [...AUTOMATE_TOOL_SPECS, ...AUTOMATE_VIEW_SPECS]) {
      const tool = tools.find((t) => t.name === spec.name);
      expect(tool, spec.name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, spec.name).toBe(spec.kind === "read");
    }
  });
});

describe("Automate reads", () => {
  it("search_computers ANDs filters with the condition and defaults to compact fields", async () => {
    const { fetchImpl, calls } = router({ "GET /Computers": [{ Id: "7", ComputerName: "SRV1" }] });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_automate_search_computers", {
      name: "SRV",
      clientId: 5,
      status: "Offline",
      type: "Server",
      condition: "IsRebootNeeded = true",
      pageSize: 1,
    });
    const q = calls[0].query;
    expect(q.get("condition")).toBe(
      "(IsRebootNeeded = true) and (ComputerName contains 'SRV') and (Client.Id = 5) and (Status = 'Offline') and (Type = 'Server')",
    );
    expect(q.get("includefields")).toContain("ComputerName");
    expect(q.get("pagesize")).toBe("1");
    expect(out).toMatchObject({ count: 1, hasMore: true, items: [{ Id: "7" }] });
  });

  it("search_computers returns full records with fields=all and refuses a quote in a filter", async () => {
    const { fetchImpl, calls } = router({ "GET /Computers": [] });
    const client = await connect(fetchImpl);
    await call(client, "cw_automate_search_computers", { fields: "all" });
    expect(calls[0].query.get("includefields")).toBeNull();
    await expect(call(client, "cw_automate_search_computers", { name: "O'Brien" })).rejects.toThrow(/single quote/);
  });

  it("get_computer accepts the string Id Automate itself returns", async () => {
    const { fetchImpl, calls } = router({ "GET /Computers/42": { Id: "42", ComputerName: "PC" } });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_automate_get_computer", { id: "42" });
    expect(calls[0].path).toBe("/Computers/42");
    expect(out.ComputerName).toBe("PC");
  });

  it.each([
    ["cw_automate_get_computer_software", "/Computers/3/Software", "Name asc"],
    ["cw_automate_get_computer_services", "/Computers/3/Services", "Name asc"],
    ["cw_automate_get_computer_drives", "/Computers/3/Drives", "Letter asc"],
    ["cw_automate_get_computer_alerts", "/Computers/3/Alerts", "AlertDate desc"],
    ["cw_automate_get_computer_monitors", "/Computers/3/Monitors", "Name asc"],
    ["cw_automate_get_computer_script_history", "/Computers/3/ScriptHistory", "HistoryDate desc"],
    ["cw_automate_get_computer_command_history", "/Computers/3/CommandHistory", "DateExecuted desc"],
  ])("%s reads %s", async (name, path, orderBy) => {
    const { fetchImpl, calls } = router({ [`GET ${path}`]: [{ a: 1 }] });
    const client = await connect(fetchImpl);
    const out = await call(client, name, { computerId: 3, condition: "x = 'y'" });
    expect(calls[0].path).toBe(path);
    expect(calls[0].query.get("orderby")).toBe(orderBy);
    expect(calls[0].query.get("condition")).toBe("x = 'y'");
    expect(out.count).toBe(1);
  });

  it("get_computer_patching combines stats, policy and missing updates", async () => {
    const { fetchImpl, calls } = router({
      "GET /Computers/3/PatchingStats": { OverallCompliance: 90, MissingPatchCount: 2 },
      "GET /Computers/3/EffectivePatchingPolicy": { Name: "Default" },
      "GET /Computers/3/MicrosoftUpdates": [{ KnowledgeBaseId: "KB1", IsInstalled: false }],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_automate_get_computer_patching", { computerId: 3 });
    expect(out.stats.OverallCompliance).toBe(90);
    expect(out.effectivePolicy.Name).toBe("Default");
    expect(out.microsoftUpdates).toMatchObject({ count: 1, missingOnly: true });
    expect(calls.find((c) => c.path.endsWith("MicrosoftUpdates"))?.query.get("condition")).toBe("IsInstalled = false");
    expect(calls.some((c) => c.path.endsWith("ThirdPartyPatches"))).toBe(false);
  });

  it("get_computer_hardware keeps going when one sub-read fails", async () => {
    const { fetchImpl } = router({
      "GET /Computers/3/OperatingSystem": { Name: "Windows" },
      "GET /Computers/3/Bios": { Manufacturer: "Dell" },
      "GET /Computers/3/Processors": [{ Name: "Xeon" }],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_automate_get_computer_hardware", { computerId: 3 });
    expect(out.operatingSystem.Name).toBe("Windows");
    expect(out.printers.error).toMatch(/no route/);
  });

  it("get_command_result finds the queued command, or says which ids to check", async () => {
    const { fetchImpl, calls } = router({
      "GET /Computers/3/CommandExecute": (url: URL) =>
        url.searchParams.get("condition") === "Id = 99" ? [{ Id: 99, Status: "Success", Output: "ok" }] : [],
    });
    const client = await connect(fetchImpl);
    expect(await call(client, "cw_automate_get_command_result", { computerId: 3, commandExecuteId: 99 })).toMatchObject({ Status: "Success" });
    expect(calls[0].query.get("condition")).toBe("Id = 99");
    await expect(call(client, "cw_automate_get_command_result", { computerId: 3, commandExecuteId: 1 })).rejects.toThrow(/No command 1/);
  });

  it.each([
    ["cw_automate_list_clients", "/Clients", {}],
    ["cw_automate_list_groups", "/Groups", {}],
    ["cw_automate_list_alerts", "/Alerts", {}],
    ["cw_automate_list_monitors", "/Monitors", {}],
    ["cw_automate_list_commands", "/Commands", {}],
    ["cw_automate_list_tickets", "/Tickets", {}],
    ["cw_automate_list_users", "/Users", {}],
    ["cw_automate_list_network_devices", "/NetworkDevices", {}],
    ["cw_automate_list_script_schedules", "/Scripting/ScriptSchedules", {}],
    ["cw_automate_list_running_scripts", "/Scripting/RunningScripts", {}],
  ])("%s lists %s", async (name, path, args) => {
    const { fetchImpl, calls } = router({ [`GET ${path}`]: [] });
    const client = await connect(fetchImpl);
    const out = await call(client, name, args);
    expect(calls[0].path).toBe(path);
    expect(out).toMatchObject({ count: 0, hasMore: false });
  });

  it("scopes locations and contacts to a client, and schedules/running scripts/patch history to a computer", async () => {
    const { fetchImpl, calls } = router({
      "GET /Locations": [],
      "GET /Contacts": [],
      "GET /Computers/8/ScheduledScripts": [],
      "GET /Computers/8/RunningScripts": [],
      "GET /PatchHistory": [],
    });
    const client = await connect(fetchImpl);
    await call(client, "cw_automate_list_locations", { clientId: 4 });
    await call(client, "cw_automate_list_contacts", { clientId: 4 });
    await call(client, "cw_automate_list_script_schedules", { computerId: 8 });
    await call(client, "cw_automate_list_running_scripts", { computerId: 8 });
    await call(client, "cw_automate_list_patch_history", { computerId: 8 });
    expect(calls.map((c) => c.path)).toEqual([
      "/Locations",
      "/Contacts",
      "/Computers/8/ScheduledScripts",
      "/Computers/8/RunningScripts",
      "/PatchHistory",
    ]);
    expect(calls[0].query.get("condition")).toBe("Client.Id = 4");
    expect(calls[4].query.get("condition")).toBe("ComputerId = 8");
  });

  it("list_scripts keeps computer scripts by default", async () => {
    const { fetchImpl, calls } = router({ "GET /Scripts": [{ Id: 1, Name: "Restart Spooler" }] });
    const client = await connect(fetchImpl);
    await call(client, "cw_automate_list_scripts", { name: "Spool" });
    expect(calls[0].query.get("condition")).toBe("(Name contains 'Spool') and (IsComputerScript = true)");
  });

  it("get_client and get_script read one record", async () => {
    const { fetchImpl } = router({ "GET /Clients/4": { Id: 4, Name: "Acme" }, "GET /Scripts/9": { Id: 9 } });
    const client = await connect(fetchImpl);
    expect((await call(client, "cw_automate_get_client", { id: 4 })).Name).toBe("Acme");
    expect((await call(client, "cw_automate_get_script", { id: 9 })).Id).toBe(9);
  });

  it("test_connection reports server time and whether the login is an integrator", async () => {
    const { fetchImpl } = router({
      "GET /DatabaseServerTime": "2026-10-22T12:00:00",
      "GET /Users": [{ UserId: 1, Name: "api-user", IsIntegrator: false, IsLocked: false }],
    });
    const client = await connect(fetchImpl);
    const out = await call(client, "cw_automate_test_connection");
    expect(out).toMatchObject({ ok: true, serverTime: "2026-10-22T12:00:00", login: { username: "api-user", isIntegrator: false } });
    expect(out.hint).toMatch(/integrator/i);
    expect(JSON.stringify(out)).not.toContain("mock"); // the password never appears
  });

  it("api_get issues GET only and strips a pasted /cwa/api/v1 prefix", async () => {
    const { fetchImpl, calls } = router({ "GET /EventLogs": [] });
    const client = await connect(fetchImpl);
    await call(client, "cw_automate_api_get", { path: "/cwa/api/v1/EventLogs" });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/EventLogs" });
  });
});

describe("Automate writes (gate open, all mocked)", () => {
  it("run_script posts a Computer batch to /Batch/ScriptExecute", async () => {
    const { fetchImpl, calls } = router({ "POST /Batch/ScriptExecute": { Message: "queued" } });
    const client = await connect(fetchImpl, WRITE);
    const out = await call(client, "cw_automate_run_script", {
      computerIds: [3, 4],
      scriptId: 77,
      parameters: { ServiceName: "Spooler" },
      confirm: true,
    });
    expect(calls[0].body).toEqual({
      EntityType: "Computer",
      EntityIds: [3, 4],
      ScriptId: 77,
      Parameters: [{ Key: "ServiceName", Value: "Spooler" }],
      OfflineActionFlags: { SkipsOfflineAgents: true },
      Priority: 5,
    });
    expect(out).toMatchObject({ queued: true, scriptId: 77 });
  });

  it("run_command queues a harmless command in write mode", async () => {
    const { fetchImpl, calls } = router({
      "GET /Commands/28": { Id: 28, Name: "Scanning Services" },
      "POST /Computers/3/CommandExecute": { Id: 501, Status: "Pending" },
    });
    const client = await connect(fetchImpl, WRITE);
    const out = await call(client, "cw_automate_run_command", { computerId: 3, commandId: 28, confirm: true });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/Computers/3/CommandExecute", body: { ComputerId: 3, Command: { Id: "28" }, Parameters: [] } });
    expect(out).toMatchObject({ queued: true, commandExecuteId: 501, status: "Pending" });
  });

  it("run_command treats a disruptive command as the disruptive tier, by its name", async () => {
    const { fetchImpl, calls } = router({
      "GET /Commands/59": { Id: 59, Name: "Service Stop" },
      "POST /Computers/3/CommandExecute": { Id: 502 },
    });
    const refused = await connect(fetchImpl, WRITE);
    await expect(call(refused, "cw_automate_run_command", { computerId: 3, commandId: 59, confirm: true })).rejects.toThrow(
      /CW_AUTOMATE_ALLOW_DESTRUCTIVE/,
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    const allowed = await connect(fetchImpl, WIDE);
    await call(allowed, "cw_automate_run_command", { computerId: 3, commandId: 59, confirm: true });
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("classifies the tenant's real command names", () => {
    for (const name of ["Reboot", "Shutdown", "Service Stop", "Logoff User", "Uninstall Software"]) {
      expect(DISRUPTIVE_COMMAND.test(name), name).toBe(true);
    }
    for (const name of ["Execute Command", "Scanning Services", "Service Start", "WakeOnLan", "Change Service Login"]) {
      expect(DISRUPTIVE_COMMAND.test(name), name).toBe(false);
    }
  });

  it("run_shell_command wraps the line in Execute Command's executable!!! form", async () => {
    const { fetchImpl, calls } = router({ "POST /Computers/3/CommandExecute": { Id: 503 } });
    const client = await connect(fetchImpl, WRITE);
    await call(client, "cw_automate_run_shell_command", { computerId: 3, command: 'Get-Service "Spooler"', confirm: true });
    await call(client, "cw_automate_run_shell_command", { computerId: 3, command: "ipconfig /all", shell: "cmd", confirm: true });
    expect(calls[0].body).toEqual({
      ComputerId: 3,
      Command: { Id: "2" },
      Parameters: ['powershell.exe!!! -NonInteractive -NoProfile -Command "Get-Service \\"Spooler\\""'],
    });
    expect((calls[1].body as { Parameters: string[] }).Parameters).toEqual(["cmd.exe!!! /c ipconfig /all"]);
  });

  it("reboot_computer looks the Reboot command up by name", async () => {
    const { fetchImpl, calls } = router({
      "GET /Commands": [{ Id: 68, Name: "Reboot" }],
      "POST /Computers/3/CommandExecute": { Id: 504, Status: "Pending" },
    });
    const client = await connect(fetchImpl, WIDE);
    const out = await call(client, "cw_automate_reboot_computer", { computerId: 3, confirm: true });
    expect(calls[0].query.get("condition")).toBe("Name = 'Reboot'");
    expect(calls[1].body).toMatchObject({ Command: { Id: "68" } });
    expect(out).toMatchObject({ command: "Reboot", commandExecuteId: 504 });
  });

  it("update_client and update_location PATCH replace ops for the fields given", async () => {
    const { fetchImpl, calls } = router({ "PATCH /Clients/4": { Id: 4 }, "PATCH /Locations/6": { Id: 6 } });
    const client = await connect(fetchImpl, WRITE);
    await call(client, "cw_automate_update_client", { id: 4, PhoneNumber: "555-0100", Comment: "VIP", confirm: true });
    await call(client, "cw_automate_update_location", { id: 6, City: "Irvine", confirm: true });
    // Schema order, only the fields passed, and Path without a leading slash (Automate's PatchOperation form).
    expect(calls[0].body).toEqual([
      { Op: "replace", Path: "Comment", Value: "VIP" },
      { Op: "replace", Path: "PhoneNumber", Value: "555-0100" },
    ]);
    expect(calls[1].body).toEqual([{ Op: "replace", Path: "City", Value: "Irvine" }]);
    await expect(call(client, "cw_automate_update_client", { id: 4, confirm: true })).rejects.toThrow(/at least one field/);
  });

  it("delete_script_schedule and uninstall_software hit their documented endpoints", async () => {
    const { fetchImpl, calls } = router({
      "DELETE /Scripting/ScriptSchedules/5": {},
      "GET /Computers/3/Software": [{ ApplicationId: 9, Name: "Toolbar", Version: "1.0", UninstallerPath: "C:\\u.exe /S" }],
      "POST /computers/3/software/9/uninstall": {},
    });
    const client = await connect(fetchImpl, WIDE);
    expect(await call(client, "cw_automate_delete_script_schedule", { scheduleId: 5, confirm: true })).toEqual({ deleted: true, scheduleId: 5 });
    await call(client, "cw_automate_uninstall_software", { computerId: 3, softwareId: 9, confirm: true });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/computers/3/software/9/uninstall", body: { UninstallPath: "C:\\u.exe /S" } });
  });

  it("uninstall_software refuses when Automate has no uninstaller for the app", async () => {
    const { fetchImpl, calls } = router({ "GET /Computers/3/Software": [{ ApplicationId: 9, Name: "Thing" }] });
    const client = await connect(fetchImpl, WIDE);
    await expect(call(client, "cw_automate_uninstall_software", { computerId: 3, softwareId: 9, confirm: true })).rejects.toThrow(/no uninstaller/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("api_write passes the method through when every gate is open", async () => {
    const { fetchImpl, calls } = router({ "PATCH /Scripting/ScriptSchedules/5": {} });
    const client = await connect(fetchImpl, WIDE);
    await call(client, "cw_automate_api_write", { method: "PATCH", path: "/Scripting/ScriptSchedules/5", body: [], confirm: true });
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "/Scripting/ScriptSchedules/5" });
  });
});
