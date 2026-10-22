// Interactive views (MCP Apps). Each is a read-only tool whose result the host
// can render as an HTML view; a view that acts does so by calling this server's
// own guarded write tools, so a button can never do more than the model could.
//
// The specs are exported config-independently so the catalog, the generated docs
// and the manifests can list the views; registration happens per configured
// product, exactly like the plain tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PsaClient } from "../lib/psa-client.js";
import type { AutomateClient } from "../lib/automate-client.js";
import type { ScreenConnectClient } from "../lib/screenconnect-client.js";
import type { ToolSpec } from "../tools/spec.js";
import { registerView } from "./shell.js";
import { TICKET_VIEW } from "./views/ticket.js";
import { BOARD_VIEW } from "./views/board.js";
import { COMPANY_VIEW } from "./views/company.js";
import { TIME_VIEW } from "./views/time.js";
import { AUTOMATE_COMPUTERS_VIEW } from "./views/automate-computers.js";
import { CONTROL_SESSIONS_VIEW } from "./views/control-sessions.js";

export { TICKET_CARD_URI } from "./views/ticket.js";
export const TICKET_VIEW_SPEC: ToolSpec = TICKET_VIEW.spec;
export { VIEW_MIME_TYPE, viewUri } from "./shell.js";

/** The ticket card is `cw_get_ticket`, registered among the PSA workflow tools; these are the pure views. */
export const PSA_VIEW_SPECS: ToolSpec[] = [BOARD_VIEW.spec, COMPANY_VIEW.spec, TIME_VIEW.spec];
export const AUTOMATE_VIEW_SPECS: ToolSpec[] = [AUTOMATE_COMPUTERS_VIEW.spec];
export const CONTROL_VIEW_SPECS: ToolSpec[] = [CONTROL_SESSIONS_VIEW.spec];

export function registerTicketCard(server: McpServer, client: PsaClient): void {
  registerView(server, TICKET_VIEW, client);
}

export function registerPsaViews(server: McpServer, client: PsaClient): void {
  registerView(server, BOARD_VIEW, client);
  registerView(server, COMPANY_VIEW, client);
  registerView(server, TIME_VIEW, client);
}

export function registerAutomateViews(server: McpServer, client: AutomateClient): void {
  registerView(server, AUTOMATE_COMPUTERS_VIEW, client);
}

export function registerControlViews(server: McpServer, client: ScreenConnectClient): void {
  registerView(server, CONTROL_SESSIONS_VIEW, client);
}
