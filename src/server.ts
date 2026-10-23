import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { PsaClient, type ClientDeps } from "./lib/psa-client.js";
import { AutomateClient } from "./lib/automate-client.js";
import { registerPsaTools } from "./tools/psa.js";
import { registerAutomateTools } from "./tools/automate.js";
import { registerStatusTools } from "./tools/status.js";
import { registerAutomateViews, registerPsaViews } from "./apps/index.js";
import { bindGates } from "./tools/gate.js";
import { toolsForSurfaces } from "./tools/catalog.js";
import type { ToolSurface } from "./tools/spec.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export { SERVER_NAME, SERVER_VERSION };

const INSTRUCTIONS = `ConnectWise MCP server. Every tool is named cw_*: ConnectWise PSA (Manage) tools are
cw_*, ConnectWise Automate (RMM) tools are cw_automate_*. Automate registers only when configured.

Tools come in three kinds, and the verb and annotations on each say which:
- read (cw_list_*, cw_get_*, cw_search_*, cw_test_*, cw_status_*, *_api_get) — readOnlyHint,
  safe to call freely and in parallel;
- write (cw_create_*, cw_update_*, cw_add_*, cw_automate_run_*, cw_automate_reboot_*,
  cw_automate_delete_*, cw_automate_uninstall_*, *_api_write) — change live data;
- interactive (cw_view_*, cw_automate_view_*, plus cw_get_ticket) — read tools that also render an
  MCP Apps view, and return the same JSON on hosts without one.

The write gate. Each product starts read-only. Write tools stay listed but refuse until the operator
sets CW_PSA_MODE=write (PSA) or CW_AUTOMATE_MODE=write (Automate) and restarts. The disruptive tier
(destructiveHint: reboots, script-schedule deletes, uninstalls, disruptive agent commands, the raw
*_api_write passthroughs) also needs CW_PSA_ALLOW_DESTRUCTIVE=true / CW_AUTOMATE_ALLOW_DESTRUCTIVE=true.
Every write call also takes confirm: true. cw_status_gate reports the state of both gates; when a
write refuses, relay the refusal (it names the setting) instead of retrying.

cw_status_server is always registered: call it first when a product's tools seem to be missing. It
names the environment variables and the Claude Desktop Settings > Extensions fields still empty.

PSA condition syntax (the \`conditions\` parameters):
- Operators: =, !=, <, <=, >, >=, contains, like, in, not. Combine with and/or, group with ().
- Strings in double quotes: status/name="New". Wildcards with like: name like "acme%".
- Dates in square brackets, UTC ISO-8601: lastUpdated > [2026-06-01T00:00:00Z].
- Reference fields use slashes: board/name="Help Desk", status/id in (1,2,3). Booleans: closedFlag=false.

Automate condition syntax (the \`condition\` parameters) differs: strings in SINGLE quotes,
nested fields with dots — ComputerName contains 'SRV', Client.Id = 5, Status = 'Offline',
RemoteAgentLastContact < '2026-06-01'. Automate tools also take convenience filters (clientId,
locationId, status, name) that are ANDed with any condition.

Search and list tools return a compact field set by default; pass fields="all" for complete records
or a comma-separated list to choose. Results are paginated — check hasMore and pass page to continue.

PSA ticket workflow: cw_list_boards -> cw_get_board_info (valid statuses/types) -> cw_search_tickets /
cw_create_ticket / cw_update_ticket, or cw_view_board for the whole queue; cw_get_ticket renders the
ticket card. Anything without a dedicated tool is reachable via cw_api_get and cw_api_write.

Automate workflow: cw_automate_view_fleet for the estate at a glance -> cw_automate_view_client for one
client -> cw_automate_view_computer for one machine (drives, patching, alerts, script history, and a
Run script panel). cw_automate_search_computers finds machines; the cw_automate_get_computer_* tools
read software, services, drives, alerts, patching, hardware, monitors, script and command history.
To act on a machine: cw_automate_list_scripts -> cw_automate_run_script, or cw_automate_list_commands
-> cw_automate_run_command, then read the outcome with cw_automate_get_command_result or
cw_automate_get_computer_script_history. Automate's REST API cannot acknowledge or clear alerts and
cannot edit a computer record; say so rather than reaching for cw_automate_api_write.`;

// A public URL rather than a data: URI: everything on the MCP hostname sits behind
// Cloudflare Access, and clients fetch icons without credentials. The file is served
// from the mcp-icons R2 bucket.
const SERVER_ICONS = [
  { src: "https://mcp-icons.divergeitconsulting.com/connectwise.png", mimeType: "image/png", sizes: ["512x512"] },
];

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
  return surfaces;
}

export function createServer(
  config: AppConfig,
  deps: ClientDeps = {},
  options: ServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, icons: SERVER_ICONS },
    { instructions: INSTRUCTIONS },
  );
  // Before any tool is registered: write tools look their gate up per call.
  bindGates(server, config.gates);

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
  return server;
}
