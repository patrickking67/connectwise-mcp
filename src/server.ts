import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { PsaClient, type ClientDeps } from "./lib/psa-client.js";
import { AutomateClient } from "./lib/automate-client.js";
import { ScreenConnectClient } from "./lib/screenconnect-client.js";
import { registerPsaTools } from "./tools/psa.js";
import { registerAutomateTools } from "./tools/automate.js";
import { registerScreenConnectTools } from "./tools/screenconnect.js";
import { registerStatusTools } from "./tools/status.js";
import { registerAutomateViews, registerControlViews, registerPsaViews } from "./apps/index.js";
import { toolsForSurfaces } from "./tools/catalog.js";
import type { ToolSurface } from "./tools/spec.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export { SERVER_NAME, SERVER_VERSION };

const INSTRUCTIONS = `ConnectWise Manage MCP server. Every tool is named cw_*: ConnectWise PSA (Manage)
tools are cw_*, ConnectWise Automate (RMM) tools are cw_automate_*, and ConnectWise Control
(ScreenConnect, beta) tools are cw_control_*. Automate and Control register only when configured.

Tools come in three kinds, and the annotations on each say which:
- read (readOnlyHint) — searches, lookups and status, safe to call freely and in parallel;
- write (readOnlyHint false) — cw_create_*, cw_update_*, cw_add_*, and the cw_*_api_write escape
  hatches, which change live ConnectWise data;
- interactive (cw_view_*, plus cw_get_ticket) — read tools that also render an MCP Apps view on
  hosts that support it, and return the same JSON everywhere else.

cw_status_server is always registered, whatever is configured: call it first when a product's
tools seem to be missing. It names the environment variables and the Claude Desktop
Settings > Extensions fields that are still empty.

PSA condition syntax (the \`conditions\` parameters):
- Operators: =, !=, <, <=, >, >=, contains, like, in, not. Combine with and/or, group with ().
- Strings in double quotes: status/name="New". Wildcards with like: name like "acme%".
- Dates in square brackets, UTC ISO-8601: lastUpdated > [2026-06-01T00:00:00Z].
- Reference fields use slashes: board/name="Help Desk", status/id in (1,2,3). Booleans: closedFlag=false.
- Only fields present on the entity can be used in conditions.

Search tools return a compact field set by default; pass fields="all" for complete records or a
comma-separated list to choose. Results are paginated — check hasMore and pass page to continue.

Ticket workflow: cw_list_boards -> cw_get_board_info (valid statuses/types for that board) ->
cw_search_tickets / cw_create_ticket / cw_update_ticket, or cw_view_board for the whole queue.
Anything without a dedicated tool is reachable via cw_api_get (read) and cw_api_write (change):
procurement, marketing, KB articles, setup tables, and the rest of the 1,800+ endpoint REST surface.`;

export interface ServerOptions {
  /** Why the configuration could not be loaded, when it could not. Reported by cw_status_server. */
  configError?: string;
  /** Environment cw_status_server inspects for missing variables. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** The products this configuration turns on. */
export function configuredSurfaces(config: AppConfig): ToolSurface[] {
  const surfaces: ToolSurface[] = [];
  if (config.psa) surfaces.push("psa");
  if (config.automate) surfaces.push("automate");
  if (config.screenconnect) surfaces.push("control");
  return surfaces;
}

export function createServer(
  config: AppConfig,
  deps: ClientDeps = {},
  options: ServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  // Registered first and unconditionally: a server with nothing configured has
  // to be able to say so, and a host that sees no tools at all cannot ask.
  registerStatusTools(server, {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    config,
    configError: options.configError,
    env: options.env,
    toolNames: () => toolsForSurfaces(configuredSurfaces(config)).map((spec) => spec.name),
  });

  if (config.psa) {
    const client = new PsaClient(config.psa, deps);
    registerPsaTools(server, client);
    registerPsaViews(server, client);
  }
  if (config.automate) {
    const client = new AutomateClient(config.automate, deps);
    registerAutomateTools(server, client);
    registerAutomateViews(server, client);
  }
  if (config.screenconnect) {
    const client = new ScreenConnectClient(config.screenconnect, deps);
    registerScreenConnectTools(server, client);
    registerControlViews(server, client);
  }
  return server;
}
