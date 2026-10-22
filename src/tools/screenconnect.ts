import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ScreenConnectClient } from "../lib/screenconnect-client.js";
import { jsonResult, errorResult } from "../lib/format.js";
import { registerSpecTool, type ToolSpec } from "./spec.js";

/**
 * Control is the one surface that does not split read from write by HTTP verb: its
 * `.ashx` services answer reads over POST. So the passthrough keeps both methods and
 * stays classified as a write, with the POST guard the module has always had.
 */
const SPECS = {
  listSessions: {
    name: "cw_control_list_sessions",
    title: "List Control Sessions",
    summary: "List ConnectWise Control host sessions (beta)",
    surface: "control",
    kind: "read",
  },
  apiWrite: {
    name: "cw_control_api_write",
    summary: "Call a ConnectWise Control endpoint; POST needs confirm: true (beta)",
    surface: "control",
    kind: "write",
    destructive: true,
  },
} satisfies Record<string, ToolSpec>;

export const CONTROL_TOOL_SPECS: ToolSpec[] = Object.values(SPECS);

export function registerScreenConnectTools(server: McpServer, client: ScreenConnectClient): void {
  registerSpecTool<{ sessionType?: "Access" | "Support" | "Meeting" }>(
    server,
    SPECS.listSessions,
    {
      description:
        "List ConnectWise Control (ScreenConnect) host sessions — access machines, support, or meetings. BETA: the response shape is Control-version-specific; if this errors, use cw_control_api_write with method GET.",
      inputSchema: {
        sessionType: z
          .enum(["Access", "Support", "Meeting"])
          .optional()
          .describe("Session type (default Access — unattended machines)"),
      },
    },
    async ({ sessionType }) => {
      const typeMap = { Support: 0, Meeting: 1, Access: 2 } as const;
      return jsonResult(await client.listSessions(typeMap[sessionType ?? "Access"]));
    },
  );

  registerSpecTool<{
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    confirm?: boolean;
  }>(
    server,
    SPECS.apiWrite,
    {
      description:
        "Authenticated passthrough to a ConnectWise Control (ScreenConnect) instance. Paths are relative to the instance root, e.g. POST /Services/PageService.ashx/GetHostSessionInfo or /Services/SessionGroupService.ashx. Control answers many reads over POST, so POST is available — and because a POST can also act on live remote-access infrastructure, it requires confirm: true. BETA: endpoint signatures are version-specific.",
      inputSchema: {
        method: z.enum(["GET", "POST"]),
        path: z
          .string()
          .regex(/^\//, "path must start with /")
          .describe('e.g. "/Services/PageService.ashx/GetHostSessionInfo"'),
        query: z.record(z.string()).optional(),
        body: z
          .unknown()
          .optional()
          .describe("JSON body — for .ashx services this is usually a positional argument array"),
        confirm: z.boolean().optional().describe("Must be true for POST"),
      },
    },
    async ({ method, path, query, body, confirm }) => {
      if (method === "POST" && confirm !== true) {
        return errorResult(
          new Error(
            "Refusing POST without confirm: true — ScreenConnect writes hit live remote-access infrastructure",
          ),
        );
      }
      return jsonResult(await client.request(method, path, { query, body }));
    },
  );
}
