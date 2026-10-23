import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createServer } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

// Local stdio entry point for Claude Code / Claude Desktop:
//   claude mcp add connectwise -e CW_PSA_SITE=... -- node dist/stdio.js

// A stdio server that dies mid-handshake shows up in the host log as
// "transport closed unexpectedly" with no cause. Print the reason to stderr,
// which is what the host captures, before exiting.
process.on("uncaughtException", (err) => {
  console.error(`${SERVER_NAME}: uncaught exception:`, err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(`${SERVER_NAME}: unhandled rejection:`, err);
  process.exit(1);
});

// This server always starts, whatever is configured — including nothing.
//
// It used to exit when no product was configured, which is exactly the case a
// person needs help with: in Claude Desktop a half-filled Settings > Extensions
// form (an Automate URL and password but no username, say) produces no config at
// all, and the extension then showed only "server disconnected". Now the server
// starts with cw_status_server alone, and that tool names the missing variables
// and the Settings fields they come from.
let config: AppConfig;
let configError: string | undefined;
try {
  config = loadConfig();
} catch (err) {
  configError = err instanceof Error ? err.message : String(err);
  console.error(`${SERVER_NAME}: ${configError}`);
  config = { port: 8080 };
}

const server = createServer(config, {}, { configError });
const transport = new StdioServerTransport();
await server.connect(transport);

const products = `psa=${config.psa ? "yes" : "no"} automate=${config.automate ? "yes" : "no"}`;
console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (${products})`);
if (!config.psa && !config.automate) {
  console.error(
    `${SERVER_NAME}: no ConnectWise product is configured, so only cw_status_server and cw_status_gate are registered. ` +
      `Set CW_PSA_* for PSA (Manage) or CW_AUTOMATE_* for Automate. ` +
      `In Claude Desktop these come from Settings > Extensions — enable the extension and fill every ` +
      `field for the product. Call cw_status_server for the exact list.`,
  );
}
