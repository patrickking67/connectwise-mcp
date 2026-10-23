import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AutomateClient, AutomateListResult } from "../lib/automate-client.js";
import { jsonResult, errorResult } from "../lib/format.js";
import { registerSpecTool, type ToolSpec } from "./spec.js";
import { gateFor, gateRefusal } from "./gate.js";

// ConnectWise Automate (RMM) tools, registered only when CW_AUTOMATE_* is set.
//
// Every endpoint here is in ConnectWise's published Automate REST API (the
// swagger ConnectWise ships, as captured in covenanttechnologysolutions/
// connectwise-rest generator/automate-json/*.json, Automate 2025.0.5), and
// every GET was confirmed against a live Automate server. Paths are relative to
// /cwa/api/v1. Two things technicians often ask for are NOT in that API and so
// have no tool: acknowledging/clearing an alert, and editing a computer record.
//
// Automate list endpoints take condition / includefields / orderby / page /
// pagesize and return a bare array with no paging headers, so hasMore is
// inferred from a full page.

type Rec = Record<string, unknown>;

const pagingShape = {
  page: z.number().int().min(1).optional().describe("Page number (default 1)"),
  pageSize: z.number().int().min(1).max(1000).optional().describe("Results per page (default 25, max 1000)"),
};

function listShape(conditionHint: string, orderHint = '"Id desc"') {
  return {
    condition: z
      .string()
      .optional()
      .describe(`Automate condition expression, single quotes for strings, e.g. ${conditionHint}`),
    fields: z
      .string()
      .optional()
      .describe('Comma-separated fields to return; "all" for full records. Defaults to a compact set.'),
    orderBy: z.string().optional().describe(`Sort, e.g. ${orderHint}`),
    ...pagingShape,
  };
}

type ListArgs = { condition?: string; fields?: string; orderBy?: string; page?: number; pageSize?: number };

/** fields: omitted -> compact default, "all" -> every field, anything else -> the caller's list. */
function resolveFields(input: string | undefined, fallback?: string): string | undefined {
  if (input === "all") return undefined;
  return input || fallback;
}

/** AND together the caller's condition and any convenience filters. */
function andConditions(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((p): p is string => Boolean(p && p.trim()));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return present.map((p) => `(${p})`).join(" and ");
}

/** A string for an Automate condition. Values with a quote are refused rather than guessed at. */
function quoted(value: string): string {
  if (value.includes("'")) throw new Error(`Value ${JSON.stringify(value)} contains a single quote; pass a condition instead`);
  return `'${value}'`;
}

function listResult<T>(result: AutomateListResult<T>): ReturnType<typeof jsonResult> {
  return jsonResult({ count: result.items.length, page: result.page, hasMore: result.hasMore, items: result.items });
}

/** Callers paste full URLs from the Automate docs; strip the version prefix they carry. */
function normalizeAutomatePath(path: string): string {
  return path.replace(/^\/cwa\/api\/v1/i, "");
}

/**
 * Automate commands that interrupt a machine or a person using it. Queuing one
 * of these is the disruptive tier, whichever tool queues it.
 */
export const DISRUPTIVE_COMMAND = /reboot|restart|shut ?down|power ?off|log ?off|stop|kill|uninstall|remove|delete|format|wipe|reset|disable/i;

export const COMPUTER_FIELDS =
  "Id,ComputerName,Client,Location,Type,Status,OperatingSystemName,LastUserName,LocalIPAddress,RemoteAgentLastContact,IsRebootNeeded,IsMaintenanceModeEnabled";

const SPECS = {
  searchComputers: { name: "cw_automate_search_computers", title: "Search Automate Computers", summary: "Search Automate agents (computers) by name, client, location, status or any condition", surface: "automate", kind: "read" },
  getComputer: { name: "cw_automate_get_computer", title: "Get Automate Computer", summary: "Get one Automate agent in full detail", surface: "automate", kind: "read" },
  getComputerSoftware: { name: "cw_automate_get_computer_software", title: "Get Automate Computer Software", summary: "List the software installed on one computer", surface: "automate", kind: "read" },
  getComputerServices: { name: "cw_automate_get_computer_services", title: "Get Automate Computer Services", summary: "List the Windows services on one computer, with state and startup type", surface: "automate", kind: "read" },
  getComputerDrives: { name: "cw_automate_get_computer_drives", title: "Get Automate Computer Drives", summary: "List one computer's drives with size, free space and SMART status", surface: "automate", kind: "read" },
  getComputerAlerts: { name: "cw_automate_get_computer_alerts", title: "Get Automate Computer Alerts", summary: "List the alerts raised for one computer", surface: "automate", kind: "read" },
  getComputerMonitors: { name: "cw_automate_get_computer_monitors", title: "Get Automate Computer Monitors", summary: "List the monitors running against one computer and their state", surface: "automate", kind: "read" },
  getComputerScriptHistory: { name: "cw_automate_get_computer_script_history", title: "Get Automate Computer Script History", summary: "List the scripts that ran on one computer and how they ended", surface: "automate", kind: "read" },
  getComputerCommandHistory: { name: "cw_automate_get_computer_command_history", title: "Get Automate Computer Command History", summary: "List the commands sent to one computer, with output", surface: "automate", kind: "read" },
  getComputerPatching: { name: "cw_automate_get_computer_patching", title: "Get Automate Computer Patching", summary: "Patch compliance for one computer: stats, effective policy and missing or failed updates", surface: "automate", kind: "read" },
  getComputerHardware: { name: "cw_automate_get_computer_hardware", title: "Get Automate Computer Hardware", summary: "Operating system, BIOS, processors and printers of one computer", surface: "automate", kind: "read" },
  getCommandResult: { name: "cw_automate_get_command_result", title: "Get Automate Command Result", summary: "Read the status and output of a queued command", surface: "automate", kind: "read" },
  listClients: { name: "cw_automate_list_clients", title: "List Automate Clients", summary: "List Automate clients (companies)", surface: "automate", kind: "read" },
  getClient: { name: "cw_automate_get_client", title: "Get Automate Client", summary: "Get one Automate client with its locations", surface: "automate", kind: "read" },
  listLocations: { name: "cw_automate_list_locations", title: "List Automate Locations", summary: "List Automate locations (sites), optionally for one client", surface: "automate", kind: "read" },
  listContacts: { name: "cw_automate_list_contacts", title: "List Automate Contacts", summary: "List Automate contacts, optionally for one client", surface: "automate", kind: "read" },
  listGroups: { name: "cw_automate_list_groups", title: "List Automate Groups", summary: "List Automate computer groups", surface: "automate", kind: "read" },
  listScripts: { name: "cw_automate_list_scripts", title: "List Automate Scripts", summary: "List Automate scripts with their folder and parameters", surface: "automate", kind: "read", appAccessible: true },
  getScript: { name: "cw_automate_get_script", title: "Get Automate Script", summary: "Get one Automate script's definition and parameters", surface: "automate", kind: "read" },
  listScriptSchedules: { name: "cw_automate_list_script_schedules", title: "List Automate Script Schedules", summary: "List scheduled scripts, server-wide or for one computer", surface: "automate", kind: "read" },
  listRunningScripts: { name: "cw_automate_list_running_scripts", title: "List Automate Running Scripts", summary: "List scripts running now, server-wide or on one computer", surface: "automate", kind: "read" },
  listAlerts: { name: "cw_automate_list_alerts", title: "List Automate Alerts", summary: "List alerts across the Automate server", surface: "automate", kind: "read" },
  listMonitors: { name: "cw_automate_list_monitors", title: "List Automate Monitors", summary: "List Automate monitors and their state", surface: "automate", kind: "read" },
  listCommands: { name: "cw_automate_list_commands", title: "List Automate Commands", summary: "List the agent commands Automate can queue, with their ids", surface: "automate", kind: "read" },
  listTickets: { name: "cw_automate_list_tickets", title: "List Automate Tickets", summary: "List Automate's own tickets", surface: "automate", kind: "read" },
  listUsers: { name: "cw_automate_list_users", title: "List Automate Users", summary: "List Automate users (technicians) and whether each is an integrator account", surface: "automate", kind: "read" },
  listNetworkDevices: { name: "cw_automate_list_network_devices", title: "List Automate Network Devices", summary: "List network devices the Automate probes discovered", surface: "automate", kind: "read" },
  listPatchHistory: { name: "cw_automate_list_patch_history", title: "List Automate Patch History", summary: "List patch install history, server-wide or for one computer", surface: "automate", kind: "read" },
  testConnection: { name: "cw_automate_test_connection", title: "Test Automate Connection", summary: "Prove the Automate login works and report the server time and the login account's type", surface: "automate", kind: "read" },
  apiGet: { name: "cw_automate_api_get", summary: "GET any Automate endpoint that has no dedicated tool", surface: "automate", kind: "read" },
  runScript: { name: "cw_automate_run_script", title: "Run Automate Script", summary: "Run an Automate script now on one or more computers", surface: "automate", kind: "write", destructive: false, idempotent: false, appAccessible: true },
  runCommand: { name: "cw_automate_run_command", title: "Run Automate Command", summary: "Queue an Automate agent command on a computer (disruptive commands need the destructive gate)", surface: "automate", kind: "write", destructive: false, idempotent: false },
  runShellCommand: { name: "cw_automate_run_shell_command", title: "Run Automate Shell Command", summary: "Run a cmd or PowerShell command on a computer through the Automate agent", surface: "automate", kind: "write", destructive: false, idempotent: false },
  rebootComputer: { name: "cw_automate_reboot_computer", title: "Reboot Automate Computer", summary: "Reboot a computer through the Automate agent", surface: "automate", kind: "write", destructive: true, idempotent: false, appAccessible: true },
  updateClient: { name: "cw_automate_update_client", title: "Update Automate Client", summary: "Update contact and address fields on an Automate client", surface: "automate", kind: "write", destructive: false, idempotent: true },
  updateLocation: { name: "cw_automate_update_location", title: "Update Automate Location", summary: "Update contact and address fields on an Automate location", surface: "automate", kind: "write", destructive: false, idempotent: true },
  deleteScriptSchedule: { name: "cw_automate_delete_script_schedule", title: "Delete Automate Script Schedule", summary: "Delete a script schedule", surface: "automate", kind: "write", destructive: true, idempotent: true },
  uninstallSoftware: { name: "cw_automate_uninstall_software", title: "Uninstall Automate Computer Software", summary: "Uninstall an application from a computer through the Automate agent", surface: "automate", kind: "write", destructive: true, idempotent: false },
  apiWrite: { name: "cw_automate_api_write", summary: "POST, PUT, PATCH or DELETE an Automate endpoint, acting on live RMM agents", surface: "automate", kind: "write", destructive: true, requiresUserInteraction: true },
} satisfies Record<string, ToolSpec>;

export const AUTOMATE_SPECS = SPECS;
export const AUTOMATE_TOOL_SPECS: ToolSpec[] = Object.values(SPECS);

/** The fields an MSP edits on a client or location; Automate accepts PATCH ops on them. */
const ADDRESS_FIELDS = {
  Address1: z.string().optional(),
  Address2: z.string().optional(),
  City: z.string().optional(),
  State: z.string().optional(),
  ZipCode: z.string().optional(),
  Country: z.string().optional(),
  PhoneNumber: z.string().optional(),
  FaxNumber: z.string().optional(),
};

function patchOps(updates: Rec): Array<{ Op: "replace"; Path: string; Value: unknown }> {
  return Object.entries(updates)
    .filter(([, value]) => value !== undefined)
    .map(([Path, Value]) => ({ Op: "replace", Path, Value }));
}

const computerId = z.coerce.number().int().describe("Automate computer id (from cw_automate_search_computers)");

export function registerAutomateTools(server: McpServer, client: AutomateClient): void {
  const listTool = (
    spec: ToolSpec,
    path: string,
    description: string,
    conditionHint: string,
    defaultFields?: string,
    orderBy?: string,
  ) =>
    registerSpecTool<ListArgs>(server, spec, { description, inputSchema: listShape(conditionHint, orderBy ? `"${orderBy}"` : undefined) }, async (args) =>
      listResult(
        await client.list(path, {
          condition: args.condition,
          includeFields: resolveFields(args.fields, defaultFields),
          orderBy: args.orderBy ?? orderBy,
          page: args.page,
          pageSize: args.pageSize,
        }),
      ),
    );

  const computerListTool = (
    spec: ToolSpec,
    sub: string,
    description: string,
    conditionHint: string,
    defaultFields?: string,
    orderBy?: string,
  ) =>
    registerSpecTool<ListArgs & { computerId: number }>(
      server,
      spec,
      { description, inputSchema: { computerId, ...listShape(conditionHint, orderBy ? `"${orderBy}"` : undefined) } },
      async (args) =>
        listResult(
          await client.list(`/Computers/${args.computerId}/${sub}`, {
            condition: args.condition,
            includeFields: resolveFields(args.fields, defaultFields),
            orderBy: args.orderBy ?? orderBy,
            page: args.page,
            pageSize: args.pageSize,
          }),
        ),
    );

  // ---- Computers ---------------------------------------------------------

  registerSpecTool<ListArgs & { name?: string; clientId?: number; locationId?: number; status?: "Online" | "Offline"; type?: "Server" | "Workstation" }>(
    server,
    SPECS.searchComputers,
    {
      description:
        "Search ConnectWise Automate agents (computers). Convenience filters (name, clientId, locationId, status, type) are ANDed with any condition. Condition examples: ComputerName contains 'SRV'; Client.Id = 5; RemoteAgentLastContact < '2026-06-01'; IsRebootNeeded = true. Compact fields by default; fields=\"all\" for every field.",
      inputSchema: {
        name: z.string().optional().describe("Computer name contains this text"),
        clientId: z.number().int().optional().describe("Only this Automate client's computers"),
        locationId: z.number().int().optional().describe("Only this location's computers"),
        status: z.enum(["Online", "Offline"]).optional(),
        type: z.enum(["Server", "Workstation"]).optional().describe("Computer type"),
        ...listShape("ComputerName contains 'SRV'", '"ComputerName asc"'),
      },
    },
    async (args) =>
      listResult(
        await client.list("/Computers", {
          condition: andConditions(
            args.condition,
            args.name ? `ComputerName contains ${quoted(args.name)}` : undefined,
            args.clientId !== undefined ? `Client.Id = ${args.clientId}` : undefined,
            args.locationId !== undefined ? `Location.Id = ${args.locationId}` : undefined,
            args.status ? `Status = ${quoted(args.status)}` : undefined,
            args.type ? `Type = ${quoted(args.type)}` : undefined,
          ),
          includeFields: resolveFields(args.fields, COMPUTER_FIELDS),
          orderBy: args.orderBy ?? "ComputerName asc",
          page: args.page,
          pageSize: args.pageSize,
        }),
      ),
  );

  registerSpecTool<{ id: number; fields?: string }>(
    server,
    SPECS.getComputer,
    {
      description:
        "Get one Automate agent/computer by id with full detail (OS, last contact, IPs, memory, uptime, logged-in users, AV, reboot-needed, serial, warranty). Pass fields to narrow it.",
      inputSchema: { id: computerId, fields: z.string().optional().describe("Comma-separated fields; omit for everything") },
    },
    async ({ id, fields }) => jsonResult(await client.get(`/Computers/${id}`, { includefields: fields })),
  );

  computerListTool(
    SPECS.getComputerSoftware,
    "Software",
    "List the software installed on one computer (name, version, install date, size). Condition example: Name contains 'Chrome'.",
    "Name contains 'Office'",
    "ApplicationId,Name,Version,DateInstalled,Size,Classification,InstallationPath",
    "Name asc",
  );
  computerListTool(
    SPECS.getComputerServices,
    "Services",
    "List the Windows services on one computer with state and startup type. Condition example: State = 'Stopped' and Startup = 'Auto' (stopped automatic services).",
    "State = 'Stopped' and Startup = 'Auto'",
    "ComputerServiceId,Name,Description,State,Startup,Username",
    "Name asc",
  );
  computerListTool(
    SPECS.getComputerDrives,
    "Drives",
    "List one computer's drives: letter, size and free space (MB), file system, SMART status, internal/SSD flags.",
    "IsMissing = false",
    "DriveId,Letter,VolumeName,Size,FreeSpace,FileSystem,SmartStatus,IsSolidState,IsInternal,IsMissing",
    "Letter asc",
  );
  computerListTool(
    SPECS.getComputerAlerts,
    "Alerts",
    "List the alerts raised for one computer. Automate's REST API has no endpoint to acknowledge or clear an alert; do that in the Automate Control Center.",
    "Severity = 'Error'",
    undefined,
    "AlertDate desc",
  );
  computerListTool(
    SPECS.getComputerMonitors,
    "Monitors",
    "List the monitors running against one computer, their state and when they last failed.",
    "State = 'Failed'",
    "MonitorId,Name,State,LastScanned,LastFailed",
    "Name asc",
  );
  computerListTool(
    SPECS.getComputerScriptHistory,
    "ScriptHistory",
    "List the scripts that ran on one computer — who ran them, when, and how they ended (Status, DiagnosticMessage). Newest first.",
    "Status = 'Failed'",
    "Id,ScriptId,Name,User,Status,State,HistoryDate,DiagnosticMessage",
    "HistoryDate desc",
  );
  computerListTool(
    SPECS.getComputerCommandHistory,
    "CommandHistory",
    "List the commands sent to one computer with status, parameters and output. Newest first.",
    "Status = 'Failed'",
    "Id,CommandId,Command,Status,Parameters,Output,User,DateExecuted,DateFinished",
    "DateExecuted desc",
  );

  registerSpecTool<{ computerId: number; missingOnly?: boolean; includeThirdParty?: boolean; pageSize?: number }>(
    server,
    SPECS.getComputerPatching,
    {
      description:
        "Patch compliance for one computer: overall compliance, installed/missing/failed counts, last and next install windows, the effective patching policy, and the Microsoft updates that are missing or failed (missingOnly=false for every update). includeThirdParty adds third-party patches.",
      inputSchema: {
        computerId,
        missingOnly: z.boolean().optional().describe("Only updates that are not installed (default true)"),
        includeThirdParty: z.boolean().optional().describe("Also list third-party patches (default false)"),
        pageSize: z.number().int().min(1).max(1000).optional().describe("Updates to return (default 100)"),
      },
    },
    async ({ computerId: id, missingOnly, includeThirdParty, pageSize }) => {
      const [stats, policy, updates, thirdParty] = await Promise.all([
        client.get(`/Computers/${id}/PatchingStats`),
        client.get(`/Computers/${id}/EffectivePatchingPolicy`).catch(() => undefined),
        client.list(`/Computers/${id}/MicrosoftUpdates`, {
          condition: missingOnly === false ? undefined : "IsInstalled = false",
          includeFields: "MicrosoftUpdateId,KnowledgeBaseId,Title,Category,Severity,ReleaseDate,InstallState,IsInstalled,IsFailed,PolicyApproval,Cvss",
          orderBy: "ReleaseDate desc",
          pageSize: pageSize ?? 100,
        }),
        includeThirdParty ? client.list(`/Computers/${id}/ThirdPartyPatches`, { pageSize: pageSize ?? 100 }) : undefined,
      ]);
      return jsonResult({
        stats,
        effectivePolicy: policy,
        microsoftUpdates: { count: updates.items.length, hasMore: updates.hasMore, missingOnly: missingOnly !== false, items: updates.items },
        thirdPartyPatches: thirdParty ? { count: thirdParty.items.length, hasMore: thirdParty.hasMore, items: thirdParty.items } : undefined,
      });
    },
  );

  registerSpecTool<{ computerId: number }>(
    server,
    SPECS.getComputerHardware,
    {
      description: "Operating system (edition, build, install date, domain role), BIOS, processors and printers of one computer.",
      inputSchema: { computerId },
    },
    async ({ computerId: id }) => {
      const settle = <T>(p: Promise<T>) => p.catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
      const [operatingSystem, bios, processors, printers] = await Promise.all([
        settle(client.get(`/Computers/${id}/OperatingSystem`)),
        settle(client.get(`/Computers/${id}/Bios`)),
        settle(client.get(`/Computers/${id}/Processors`)),
        settle(client.get(`/Computers/${id}/Printers`)),
      ]);
      return jsonResult({ operatingSystem, bios, processors, printers });
    },
  );

  registerSpecTool<{ computerId: number; commandExecuteId: number }>(
    server,
    SPECS.getCommandResult,
    {
      description:
        "Read a queued command's status and output, by the id cw_automate_run_command / cw_automate_run_shell_command / cw_automate_reboot_computer returned. Status moves from Pending to Executing to Success or Failed as the agent checks in.",
      inputSchema: { computerId, commandExecuteId: z.number().int().describe("The Id the run tool returned") },
    },
    async ({ computerId: id, commandExecuteId }) => {
      const result = await client.list(`/Computers/${id}/CommandExecute`, { condition: `Id = ${commandExecuteId}`, pageSize: 1 });
      if (result.items.length === 0) {
        return errorResult(new Error(`No command ${commandExecuteId} on computer ${id}; check both ids (cw_automate_get_computer_command_history lists past commands)`));
      }
      return jsonResult(result.items[0]);
    },
  );

  // ---- Clients, locations, contacts, groups ------------------------------

  listTool(SPECS.listClients, "/Clients", "List Automate clients (companies). Condition example: Name contains 'Acme'.", "Name contains 'Acme'", "Id,Name,City,State,PhoneNumber,ExternalId", "Name asc");

  registerSpecTool<{ id: number }>(
    server,
    SPECS.getClient,
    { description: "Get one Automate client by id with its locations and contact details.", inputSchema: { id: z.number().int().describe("Automate client id") } },
    async ({ id }) => jsonResult(await client.get(`/Clients/${id}`)),
  );

  registerSpecTool<ListArgs & { clientId?: number }>(
    server,
    SPECS.listLocations,
    {
      description: "List Automate locations (sites). clientId narrows to one client.",
      inputSchema: { clientId: z.number().int().optional().describe("Only this client's locations"), ...listShape("Name contains 'Main'", '"Name asc"') },
    },
    async (args) =>
      listResult(
        await client.list("/Locations", {
          condition: andConditions(args.condition, args.clientId !== undefined ? `Client.Id = ${args.clientId}` : undefined),
          includeFields: resolveFields(args.fields, "Id,Name,Client,City,State,PhoneNumber,Contact"),
          orderBy: args.orderBy ?? "Name asc",
          page: args.page,
          pageSize: args.pageSize,
        }),
      ),
  );

  registerSpecTool<ListArgs & { clientId?: number }>(
    server,
    SPECS.listContacts,
    {
      description: "List Automate contacts. clientId narrows to one client.",
      inputSchema: { clientId: z.number().int().optional().describe("Only this client's contacts"), ...listShape("LastName = 'Smith'", '"LastName asc"') },
    },
    async (args) =>
      listResult(
        await client.list("/Contacts", {
          condition: andConditions(args.condition, args.clientId !== undefined ? `Client.Id = ${args.clientId}` : undefined),
          includeFields: resolveFields(args.fields, "Id,FirstName,LastName,Email,PhoneNumber,MobileNumber,Client"),
          orderBy: args.orderBy ?? "LastName asc",
          page: args.page,
          pageSize: args.pageSize,
        }),
      ),
  );

  listTool(SPECS.listGroups, "/Groups", "List Automate computer groups with their full path and auto-join search.", "Name contains 'Patching'", "Id,Name,FullName,ParentId,TypeName,Comments", "FullName asc");

  // ---- Scripts -------------------------------------------------------------

  registerSpecTool<ListArgs & { name?: string; computerScriptsOnly?: boolean }>(
    server,
    SPECS.listScripts,
    {
      description:
        "List Automate scripts with folder path and declared parameters. name filters by name; computerScriptsOnly (default true) keeps the scripts that can run against a computer — the ones cw_automate_run_script accepts.",
      inputSchema: {
        name: z.string().optional().describe("Script name contains this text"),
        computerScriptsOnly: z.boolean().optional().describe("Only computer scripts (default true)"),
        ...listShape("FullFolderPath contains 'Maintenance'", '"Name asc"'),
      },
    },
    async (args) =>
      listResult(
        await client.list("/Scripts", {
          condition: andConditions(
            args.condition,
            args.name ? `Name contains ${quoted(args.name)}` : undefined,
            args.computerScriptsOnly === false ? undefined : "IsComputerScript = true",
          ),
          includeFields: resolveFields(args.fields, "Id,Name,FullFolderPath,Comments,Parameters,IsOffline,UpdateDate"),
          orderBy: args.orderBy ?? "Name asc",
          page: args.page,
          pageSize: args.pageSize,
        }),
      ),
  );

  registerSpecTool<{ id: number }>(
    server,
    SPECS.getScript,
    { description: "Get one Automate script by id: folder, flags, comments and declared parameters.", inputSchema: { id: z.number().int().describe("Script id") } },
    async ({ id }) => jsonResult(await client.get(`/Scripts/${id}`)),
  );

  registerSpecTool<ListArgs & { computerId?: number }>(
    server,
    SPECS.listScriptSchedules,
    {
      description: "List scheduled scripts. With computerId, the schedules targeting that computer; without, every schedule on the server (script, target, frequency, next run).",
      inputSchema: { computerId: computerId.optional(), ...listShape("IsDisabled = false") },
    },
    async (args) => {
      const path = args.computerId !== undefined ? `/Computers/${args.computerId}/ScheduledScripts` : "/Scripting/ScriptSchedules";
      return listResult(
        await client.list(path, { condition: args.condition, includeFields: resolveFields(args.fields), orderBy: args.orderBy, page: args.page, pageSize: args.pageSize }),
      );
    },
  );

  registerSpecTool<{ computerId?: number; page?: number; pageSize?: number }>(
    server,
    SPECS.listRunningScripts,
    {
      description: "List scripts running right now — server-wide, or on one computer with computerId.",
      inputSchema: { computerId: computerId.optional(), ...pagingShape },
    },
    async ({ computerId: id, page, pageSize }) =>
      listResult(await client.list(id !== undefined ? `/Computers/${id}/RunningScripts` : "/Scripting/RunningScripts", { page, pageSize })),
  );

  // ---- Server-wide lists ---------------------------------------------------

  listTool(SPECS.listAlerts, "/Alerts", "List alerts across the Automate server, newest first. Read-only: Automate's REST API cannot acknowledge or clear alerts.", "Severity = 'Error'", undefined, "AlertDate desc");
  listTool(SPECS.listMonitors, "/Monitors", "List Automate monitors (internal and remote) with state, interval and failure counts. Condition example: MonitorState = 'Failed'.", "MonitorState = 'Failed'", "MonitorId,Name,MonitorState,IsInternalMonitor,Interval,FailureCount,WarningCount,LastChecked,LastFailed", "Name asc");
  listTool(SPECS.listCommands, "/Commands", "List the agent commands Automate can queue (Id, Name, Description). The Id is what cw_automate_run_command takes.", "Name contains 'Service'", undefined, "Name asc");
  listTool(SPECS.listTickets, "/Tickets", "List Automate's own tickets (the RMM ticket table, separate from PSA). Condition example: Status = 'Open'.", "Status = 'Open'", "TicketId,Subject,Status,Priority,Client,StartDate,UpdateDate,From", "UpdateDate desc");
  listTool(SPECS.listUsers, "/Users", "List Automate users with last login, lock state and whether each is an integrator (API) account.", "IsLocked = false", "UserId,Name,FirstName,LastName,EmailAddress,LastSuccessfulLogin,IsIntegrator,IsLocked,SsoStatus", "Name asc");
  listTool(SPECS.listNetworkDevices, "/NetworkDevices", "List network devices discovered by Automate probes (switches, printers, firewalls) with status and model.", "Status = 'Offline'", "Id,Name,LocalIPAddress,DeviceType,ManufacturerName,ModelName,Status,LastContact,Location,Client", "Name asc");

  registerSpecTool<ListArgs & { computerId?: number }>(
    server,
    SPECS.listPatchHistory,
    {
      description: "List patch install history (which update, when, result code), server-wide or for one computer. Newest first.",
      inputSchema: { computerId: computerId.optional(), ...listShape("ResultCode != 2", '"ActionDate desc"') },
    },
    async (args) =>
      listResult(
        await client.list("/PatchHistory", {
          condition: andConditions(args.condition, args.computerId !== undefined ? `ComputerId = ${args.computerId}` : undefined),
          includeFields: resolveFields(args.fields),
          orderBy: args.orderBy ?? "ActionDate desc",
          page: args.page,
          pageSize: args.pageSize,
        }),
      ),
  );

  registerSpecTool(
    server,
    SPECS.testConnection,
    {
      description:
        "Prove the Automate login works: obtains a token, reads the database server time, and reports whether the configured login is an integrator account (the account type meant for API use, exempt from two-factor). Read-only.",
    },
    async () => {
      const serverTime = await client.get<string>("/DatabaseServerTime");
      const username = client.username;
      const users = await client
        .list<Rec>("/Users", { condition: `Name = ${quoted(username)}`, includeFields: "UserId,Name,IsIntegrator,IsLocked", pageSize: 1 })
        .catch(() => undefined);
      const me = users?.items[0];
      return jsonResult({
        ok: true,
        server: client.serverUrl,
        serverTime,
        login: { username, isIntegrator: me?.IsIntegrator, isLocked: me?.IsLocked, found: users ? Boolean(me) : "not readable with this account" },
        hint: me && me.IsIntegrator === false ? "This is a regular user login. An integrator account is the supported API login and is exempt from two-factor." : undefined,
      });
    },
  );

  const automatePath = z
    .string()
    .regex(/^\//, "path must start with /")
    .describe('Path relative to /cwa/api/v1, e.g. "/Computers/123/Alerts"');

  registerSpecTool<{ path: string; query?: Record<string, string> }>(
    server,
    SPECS.apiGet,
    {
      description:
        "Read-only escape hatch to the ConnectWise Automate REST API (paths relative to /cwa/api/v1). GET only. Examples: /Computers/123/Printers; /MonitorStatistics; /EventLogs; /RetiredAssets. Prefer a dedicated tool when one exists; use cw_automate_api_write to change anything.",
      inputSchema: { path: automatePath, query: z.record(z.string()).optional() },
    },
    async ({ path, query }) => jsonResult(await client.request("GET", normalizeAutomatePath(path), { query })),
  );

  // ---- Writes (gated: CW_AUTOMATE_MODE=write, confirm: true) --------------

  registerSpecTool<{ computerIds: number[]; scriptId: number; parameters?: Record<string, string>; skipOffline?: boolean; priority?: number }>(
    server,
    SPECS.runScript,
    {
      description:
        "Run an Automate script now on one or more computers (POST /Batch/ScriptExecute). Use cw_automate_list_scripts to find the script id and its parameters. Offline agents are skipped by default. Returns the batch response; follow progress with cw_automate_list_running_scripts and cw_automate_get_computer_script_history. Write tool: needs CW_AUTOMATE_MODE=write and confirm: true.",
      inputSchema: {
        computerIds: z.array(z.number().int()).min(1).max(50).describe("Computers to run the script on (1-50)"),
        scriptId: z.number().int().describe("Script id (cw_automate_list_scripts)"),
        parameters: z.record(z.string()).optional().describe("Script parameters by name, e.g. {\"ServiceName\":\"Spooler\"}"),
        skipOffline: z.boolean().optional().describe("Skip agents that are offline (default true)"),
        priority: z.number().int().min(1).max(10).optional().describe("Script priority 1-10 (Automate default 5)"),
      },
    },
    async ({ computerIds, scriptId, parameters, skipOffline, priority }) => {
      // Body per Automate.Api.Domain.Contracts.BatchScripts.ScheduleScriptBatchRequest.
      const body = {
        EntityType: "Computer",
        EntityIds: computerIds,
        ScriptId: scriptId,
        Parameters: Object.entries(parameters ?? {}).map(([Key, Value]) => ({ Key, Value })),
        OfflineActionFlags: { SkipsOfflineAgents: skipOffline !== false },
        Priority: priority ?? 5,
      };
      const result = await client.request("POST", "/Batch/ScriptExecute", { body });
      return jsonResult({ queued: true, scriptId, computerIds, result });
    },
  );

  /** Queue one command and report the CommandExecute record Automate created. */
  async function queueCommand(computer: number, command: { Id: number | string; Name?: string }, parameters: string[]) {
    // Body per LabTech.Models.CommandExecute: Command.Id plus positional Parameters.
    const created = await client.request<Rec>("POST", `/Computers/${computer}/CommandExecute`, {
      body: { ComputerId: computer, Command: { Id: String(command.Id) }, Parameters: parameters },
    });
    return {
      queued: true,
      computerId: computer,
      command: command.Name ?? command.Id,
      commandExecuteId: created?.Id,
      status: created?.Status,
      next: "Read the result with cw_automate_get_command_result once the agent checks in.",
    };
  }

  registerSpecTool<{ computerId: number; commandId: number; parameters?: string[] }>(
    server,
    SPECS.runCommand,
    {
      description:
        "Queue an Automate agent command on one computer (POST /Computers/{id}/CommandExecute). Find the command id with cw_automate_list_commands. Commands that interrupt the machine or its user (reboot, shutdown, logoff, service stop, uninstall, …) are the disruptive tier and additionally need CW_AUTOMATE_ALLOW_DESTRUCTIVE=true. Returns the commandExecuteId for cw_automate_get_command_result.",
      inputSchema: {
        computerId,
        commandId: z.number().int().describe("Command id (cw_automate_list_commands)"),
        parameters: z.array(z.string()).max(10).optional().describe("Positional command parameters"),
      },
    },
    async ({ computerId: id, commandId, parameters }) => {
      const command = await client.get<Rec>(`/Commands/${commandId}`);
      const name = String(command?.Name ?? "");
      if (DISRUPTIVE_COMMAND.test(name)) {
        const refusal = gateRefusal(gateFor(server, "automate"), { tool: `${SPECS.runCommand.name} (${name})`, product: "automate", destructive: true, confirm: true });
        if (refusal) return errorResult(new Error(refusal));
      }
      return jsonResult(await queueCommand(id, { Id: commandId, Name: name }, parameters ?? []));
    },
  );

  registerSpecTool<{ computerId: number; command: string; shell?: "cmd" | "powershell" }>(
    server,
    SPECS.runShellCommand,
    {
      description:
        "Run a cmd or PowerShell command on one computer through the Automate agent's Execute Command (command id 2) and return the commandExecuteId; read the output with cw_automate_get_command_result. Runs as SYSTEM. Keep it to diagnostics where you can — a command that reboots or stops things is still possible here, so describe intent to the user first.",
      inputSchema: {
        computerId,
        command: z.string().min(1).max(4000).describe("The command line to run"),
        shell: z.enum(["cmd", "powershell"]).optional().describe("Interpreter (default powershell)"),
      },
    },
    async ({ computerId: id, command, shell }) => {
      // Automate's Execute Command takes "<executable>!!! <arguments>" — the form
      // ConnectWise's own Control Center sends, as used by gavsto/AutomateAPI
      // Invoke-AutomateCommand.
      const line =
        (shell ?? "powershell") === "powershell"
          ? `powershell.exe!!! -NonInteractive -NoProfile -Command "${command.replace(/"/g, '\\"')}"`
          : `cmd.exe!!! /c ${command}`;
      return jsonResult(await queueCommand(id, { Id: 2, Name: "Execute Command" }, [line]));
    },
  );

  registerSpecTool<{ computerId: number }>(
    server,
    SPECS.rebootComputer,
    {
      description:
        "Reboot one computer by queuing Automate's Reboot command (looked up by name in /Commands). Disruptive tier: needs CW_AUTOMATE_MODE=write, CW_AUTOMATE_ALLOW_DESTRUCTIVE=true and confirm: true. Confirm with the user that nobody is working on the machine.",
      inputSchema: { computerId },
    },
    async ({ computerId: id }) => {
      const found = await client.list<Rec>("/Commands", { condition: "Name = 'Reboot'", pageSize: 5 });
      const reboot = found.items.find((c) => String(c.Name).toLowerCase() === "reboot");
      if (!reboot) return errorResult(new Error("This Automate server has no command named Reboot (cw_automate_list_commands lists what it has)"));
      return jsonResult(await queueCommand(id, { Id: reboot.Id as number, Name: "Reboot" }, []));
    },
  );

  registerSpecTool<Rec & { id: number }>(
    server,
    SPECS.updateClient,
    {
      description:
        "Update contact and address fields on an Automate client (PATCH /Clients/{id}); only the fields you pass change. Fields: Company, FirstName, LastName, Comment, ExternalId plus the address/phone fields.",
      inputSchema: {
        id: z.number().int().describe("Automate client id"),
        Company: z.string().optional(),
        FirstName: z.string().optional(),
        LastName: z.string().optional(),
        Comment: z.string().optional(),
        ExternalId: z.number().int().optional().describe("The linked PSA company id"),
        ...ADDRESS_FIELDS,
      },
    },
    async ({ id, confirm: _confirm, ...fields }) => {
      const ops = patchOps(fields);
      if (ops.length === 0) return errorResult(new Error("Pass at least one field to change"));
      return jsonResult(await client.request("PATCH", `/Clients/${id}`, { body: ops }));
    },
  );

  registerSpecTool<Rec & { id: number }>(
    server,
    SPECS.updateLocation,
    {
      description: "Update contact and address fields on an Automate location (PATCH /Locations/{id}); only the fields you pass change.",
      inputSchema: {
        id: z.number().int().describe("Automate location id"),
        Name: z.string().optional(),
        Comments: z.string().optional(),
        ...ADDRESS_FIELDS,
      },
    },
    async ({ id, confirm: _confirm, ...fields }) => {
      const ops = patchOps(fields);
      if (ops.length === 0) return errorResult(new Error("Pass at least one field to change"));
      return jsonResult(await client.request("PATCH", `/Locations/${id}`, { body: ops }));
    },
  );

  registerSpecTool<{ scheduleId: number }>(
    server,
    SPECS.deleteScriptSchedule,
    {
      description: "Delete a script schedule (DELETE /Scripting/ScriptSchedules/{id}); the script stops running on that schedule. Disruptive tier. Find the id with cw_automate_list_script_schedules.",
      inputSchema: { scheduleId: z.number().int().describe("ScheduledScriptId") },
    },
    async ({ scheduleId }) => {
      await client.request("DELETE", `/Scripting/ScriptSchedules/${scheduleId}`);
      return jsonResult({ deleted: true, scheduleId });
    },
  );

  registerSpecTool<{ computerId: number; softwareId: number }>(
    server,
    SPECS.uninstallSoftware,
    {
      description:
        "Uninstall an application from one computer (POST /computers/{id}/software/{softwareId}/uninstall) using the uninstaller Automate inventoried. Disruptive tier. Find softwareId (ApplicationId) with cw_automate_get_computer_software.",
      inputSchema: { computerId, softwareId: z.number().int().describe("ApplicationId from cw_automate_get_computer_software") },
    },
    async ({ computerId: id, softwareId }) => {
      const found = await client.list<Rec>(`/Computers/${id}/Software`, { condition: `ApplicationId = ${softwareId}`, pageSize: 1 });
      const app = found.items[0];
      if (!app) return errorResult(new Error(`Software ${softwareId} is not in computer ${id}'s inventory`));
      if (!app.UninstallerPath) return errorResult(new Error(`Automate has no uninstaller recorded for ${String(app.Name)}`));
      await client.request("POST", `/computers/${id}/software/${softwareId}/uninstall`, { body: { UninstallPath: app.UninstallerPath } });
      return jsonResult({ queued: true, computerId: id, software: app.Name, version: app.Version });
    },
  );

  registerSpecTool<{
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query?: Record<string, string>;
    body?: unknown;
  }>(
    server,
    SPECS.apiWrite,
    {
      description:
        "Write escape hatch to the ConnectWise Automate REST API for endpoints with no dedicated tool. Every call acts on live RMM data, so it is the disruptive tier (CW_AUTOMATE_MODE=write and CW_AUTOMATE_ALLOW_DESTRUCTIVE=true), hosts ask a person on each call, and confirm: true is required.",
      inputSchema: {
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        path: automatePath,
        query: z.record(z.string()).optional(),
        body: z.unknown().optional(),
      },
    },
    async ({ method, path, query, body }) => jsonResult(await client.request(method, normalizeAutomatePath(path), { query, body })),
  );
}
