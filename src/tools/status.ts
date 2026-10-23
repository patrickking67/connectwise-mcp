import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PRODUCT_LABEL,
  PRODUCT_VARIABLES,
  productStatus,
  type AppConfig,
  type ProductKey,
} from "../config.js";
import { jsonResult } from "../lib/format.js";
import { gateReport } from "./gate.js";
import { registerSpecTool, type ToolSpec } from "./spec.js";

/**
 * The one tool that registers no matter what is configured. A server that starts
 * with nothing configured used to be indistinguishable from one that works, and a
 * server with a half-filled Automate form used to look like a server with no
 * Automate at all; this answers "what is this server, and what is it missing".
 */
export const STATUS_SPECS = {
  server: {
    name: "cw_status_server",
    title: "Server Status",
    summary: "Report which ConnectWise products are configured and what an unconfigured one still needs",
    surface: "server",
    kind: "read",
  },
  gate: {
    name: "cw_status_gate",
    title: "Write Gate Status",
    summary: "Report whether writes and the disruptive tier are enabled per product, and which setting opens each",
    surface: "server",
    kind: "read",
  },
} satisfies Record<string, ToolSpec>;

export const STATUS_TOOL_SPECS: ToolSpec[] = Object.values(STATUS_SPECS);

export interface ServerStatusInput {
  name: string;
  version: string;
  config: AppConfig;
  /** Why the configuration could not be loaded, when it could not. */
  configError?: string;
  /** Names of every tool the server registered. */
  toolNames: () => string[];
  env?: NodeJS.ProcessEnv;
}

const PRODUCT_KEYS: ProductKey[] = ["psa", "automate"];

export function serverStatus(input: ServerStatusInput): Record<string, unknown> {
  const env = input.env ?? process.env;
  const products = PRODUCT_KEYS.map((key) => {
    const configured = Boolean(input.config[key]);
    const { set, missing } = productStatus(env, key);
    const entry: Record<string, unknown> = {
      product: PRODUCT_LABEL[key],
      configured,
      toolPrefix: key === "psa" ? "cw_" : "cw_automate_",
    };
    if (!configured) {
      entry.state = set.length === 0 ? "not configured" : "incomplete";
      entry.missing = missing.map((v) => ({ env: v.env, settingsField: v.field }));
      entry.required = PRODUCT_VARIABLES[key].map((v) => ({ env: v.env, settingsField: v.field }));
      entry.howToFix =
        set.length === 0
          ? `Set every ${PRODUCT_LABEL[key]} variable (Claude Desktop: Settings > Extensions > ${PRODUCT_LABEL[key]}, enable the extension and fill every field).`
          : `Fill the missing ${PRODUCT_LABEL[key]} field(s) in Settings > Extensions, or set the missing environment variable(s), then restart the server.`;
    }
    return entry;
  });
  const configured = products.filter((p) => p.configured).length;
  return {
    server: input.name,
    version: input.version,
    ok: configured > 0 && !input.configError,
    configError: input.configError,
    productsConfigured: configured,
    tools: input.toolNames().length,
    products,
    ...(configured === 0 && !input.configError
      ? {
          hint: "No ConnectWise product is configured, so only this status tool is registered. Configure PSA or Automate and restart.",
        }
      : {}),
  };
}

export function registerStatusTools(server: McpServer, input: ServerStatusInput): void {
  registerSpecTool(
    server,
    STATUS_SPECS.server,
    {
      description:
        "Report this server's version, which ConnectWise products (PSA, Automate) are configured, how many tools are registered, and — for any product that is not configured or only partly configured — exactly which environment variables and Settings > Extensions fields are missing. Safe to call any time; the first thing to run when tools are absent.",
    },
    async () => jsonResult(serverStatus(input)),
  );
  registerSpecTool(
    server,
    STATUS_SPECS.gate,
    {
      description:
        "Report the write gate for each ConnectWise product: whether write tools may run (CW_PSA_MODE / CW_AUTOMATE_MODE = write), whether the disruptive tier (reboot, shutdown, service stop, deletes, raw *_api_write) is allowed (CW_*_ALLOW_DESTRUCTIVE = true), and the Settings > Extensions field for each. Call it when a write tool refuses. Makes no API call.",
    },
    async () => jsonResult(gateReport(server, ["psa", "automate"])),
  );
}
