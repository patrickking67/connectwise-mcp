import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { PsaClient, type ClientDeps } from "./lib/psa-client.js";
import { AutomateClient } from "./lib/automate-client.js";
import { ScreenConnectClient } from "./lib/screenconnect-client.js";
import { registerPsaTools } from "./tools/psa.js";
import { registerAutomateTools } from "./tools/automate.js";
import { registerScreenConnectTools } from "./tools/screenconnect.js";
import { registerTicketCard } from "./ui/ticket-card.js";

export const SERVER_NAME = "connectwise-manage-mcp";
export const SERVER_VERSION = "0.3.1";

const INSTRUCTIONS = `ConnectWise Manage MCP server. Every tool is named cw_*: ConnectWise PSA (Manage)
tools are cw_*, ConnectWise Automate (RMM) tools are cw_automate_*, and ConnectWise Control
(ScreenConnect, beta) tools are cw_control_*. Automate and Control register only when configured.

Tools come in three kinds, and the annotations on each say which:
- read (readOnlyHint) — searches and lookups, safe to call freely and in parallel;
- write (readOnlyHint false) — cw_create_*, cw_update_*, cw_add_*, and the cw_*_api_write escape
  hatches, which change live ConnectWise data;
- interactive — cw_get_ticket also renders an MCP Apps card on hosts that support it.

PSA condition syntax (the \`conditions\` parameters):
- Operators: =, !=, <, <=, >, >=, contains, like, in, not. Combine with and/or, group with ().
- Strings in double quotes: status/name="New". Wildcards with like: name like "acme%".
- Dates in square brackets, UTC ISO-8601: lastUpdated > [2026-06-01T00:00:00Z].
- Reference fields use slashes: board/name="Help Desk", status/id in (1,2,3). Booleans: closedFlag=false.
- Only fields present on the entity can be used in conditions.

Search tools return a compact field set by default; pass fields="all" for complete records or a
comma-separated list to choose. Results are paginated — check hasMore and pass page to continue.

Ticket workflow: cw_list_boards -> cw_get_board_info (valid statuses/types for that board) ->
cw_search_tickets / cw_create_ticket / cw_update_ticket. Anything without a dedicated tool is
reachable via cw_api_request (read) and cw_api_write (change): procurement, marketing, KB
articles, setup tables, and the rest of the 1,800+ endpoint REST surface.`;

export function createServer(config: AppConfig, deps: ClientDeps = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  if (config.psa) {
    registerPsaTools(server, new PsaClient(config.psa, deps));
    registerTicketCard(server);
  }
  if (config.automate) {
    registerAutomateTools(server, new AutomateClient(config.automate, deps));
  }
  if (config.screenconnect) {
    registerScreenConnectTools(server, new ScreenConnectClient(config.screenconnect, deps));
  }
  return server;
}
