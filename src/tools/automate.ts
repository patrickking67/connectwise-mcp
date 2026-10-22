import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AutomateClient } from "../lib/automate-client.js";
import { jsonResult, errorResult } from "../lib/format.js";
import { registerSpecTool, type ToolSpec } from "./spec.js";

const pagingShape = {
  page: z.number().int().min(1).optional().describe("Page number (default 1)"),
  pageSize: z.number().int().min(1).max(1000).optional().describe("Results per page (default 25)"),
  orderBy: z.string().optional().describe('e.g. "ComputerName asc"'),
};

const SPECS = {
  searchComputers: {
    name: "cw_automate_search_computers",
    title: "Search Automate Computers",
    summary: "Search Automate agents (computers)",
    surface: "automate",
    kind: "read",
  },
  getComputer: {
    name: "cw_automate_get_computer",
    title: "Get Automate Computer",
    summary: "Get one Automate agent in full detail",
    surface: "automate",
    kind: "read",
  },
  listClients: {
    name: "cw_automate_list_clients",
    title: "List Automate Clients",
    summary: "List Automate clients (companies)",
    surface: "automate",
    kind: "read",
  },
  apiGet: {
    name: "cw_automate_api_get",
    summary: "GET any Automate endpoint that has no dedicated tool",
    surface: "automate",
    kind: "read",
  },
  apiWrite: {
    name: "cw_automate_api_write",
    summary: "POST, PUT, PATCH or DELETE an Automate endpoint, acting on live RMM agents",
    surface: "automate",
    kind: "write",
    destructive: true,
    requiresUserInteraction: true,
  },
} satisfies Record<string, ToolSpec>;

export const AUTOMATE_TOOL_SPECS: ToolSpec[] = Object.values(SPECS);

/** Callers paste full URLs from the Automate docs; strip the version prefix they carry. */
function normalizeAutomatePath(path: string): string {
  return path.replace(/^\/cwa\/api\/v1/i, "");
}

export function registerAutomateTools(server: McpServer, client: AutomateClient): void {
  registerSpecTool<{
    condition?: string;
    includeFields?: string;
    page?: number;
    pageSize?: number;
    orderBy?: string;
  }>(
    server,
    SPECS.searchComputers,
    {
      description:
        "Search ConnectWise Automate (RMM) agents/computers. Condition examples: ComputerName contains 'SRV', Client.Id = 5, LastContactDate > 2026-06-01.",
      inputSchema: {
        condition: z
          .string()
          .optional()
          .describe("Automate condition expression (single quotes for strings)"),
        includeFields: z
          .string()
          .optional()
          .describe("Comma-separated fields to return (defaults to a compact set)"),
        ...pagingShape,
      },
    },
    async (args) => {
      const items = await client.get<unknown[]>("/Computers", {
        condition: args.condition,
        includefields:
          args.includeFields ??
          "Id,ComputerName,Client,Location,OperatingSystemName,LastContactDate,LocalIPAddress,Status",
        pagesize: args.pageSize ?? 25,
        page: args.page ?? 1,
        orderby: args.orderBy,
      });
      return jsonResult({ count: items.length, items });
    },
  );

  registerSpecTool<{ id: number }>(
    server,
    SPECS.getComputer,
    {
      description: "Get one Automate agent/computer by id with full detail.",
      inputSchema: { id: z.number().int().describe("Computer id") },
    },
    async ({ id }) => jsonResult(await client.get(`/Computers/${id}`)),
  );

  registerSpecTool<{
    condition?: string;
    includeFields?: string;
    page?: number;
    pageSize?: number;
    orderBy?: string;
  }>(
    server,
    SPECS.listClients,
    {
      description: "List Automate clients (companies). Condition example: Name contains 'Acme'.",
      inputSchema: {
        condition: z.string().optional(),
        includeFields: z.string().optional(),
        ...pagingShape,
      },
    },
    async (args) => {
      const items = await client.get<unknown[]>("/Clients", {
        condition: args.condition,
        includefields: args.includeFields,
        pagesize: args.pageSize ?? 25,
        page: args.page ?? 1,
        orderby: args.orderBy,
      });
      return jsonResult({ count: items.length, items });
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
        "Read-only escape hatch to the ConnectWise Automate REST API (paths relative to /cwa/api/v1). GET only. Examples: /Scripts; /Computers/123/Alerts; /Monitors. Use cw_automate_api_write to change anything.",
      inputSchema: { path: automatePath, query: z.record(z.string()).optional() },
    },
    async ({ path, query }) => jsonResult(await client.request("GET", normalizeAutomatePath(path), { query })),
  );

  registerSpecTool<{
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    confirm?: boolean;
  }>(
    server,
    SPECS.apiWrite,
    {
      description:
        "Write escape hatch to the ConnectWise Automate REST API. Every call acts on live RMM agents, so hosts are asked to confirm each one and confirm: true is required in addition.",
      inputSchema: {
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        path: automatePath,
        query: z.record(z.string()).optional(),
        body: z.unknown().optional(),
        confirm: z.boolean().optional().describe("Must be true — writes hit live RMM agents"),
      },
    },
    async ({ method, path, query, body, confirm }) => {
      if (confirm !== true) {
        return errorResult(
          new Error("Refusing the Automate write without confirm: true — writes hit live RMM agents"),
        );
      }
      return jsonResult(await client.request(method, normalizeAutomatePath(path), { query, body }));
    },
  );
}
