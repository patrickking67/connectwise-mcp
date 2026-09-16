import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

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

const config = loadConfig();

// Without PSA there is nothing to register, and an McpServer with no tools
// answers tools/list with "Method not found" — the host then shows a healthy
// connection that contributes nothing. Fail loudly instead.
if (!config.psa) {
  console.error(
    `${SERVER_NAME}: ConnectWise PSA is not configured, so no tools would be registered. ` +
      `Set CW_PSA_SITE, CW_PSA_COMPANY_ID, CW_PSA_PUBLIC_KEY, CW_PSA_PRIVATE_KEY and ` +
      `CW_PSA_CLIENT_ID. In Claude Desktop these come from Settings > Extensions > ConnectWise.`,
  );
  process.exit(1);
}

const server = createServer(config);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `${SERVER_NAME} v${SERVER_VERSION} running on stdio ` +
    `(psa=yes automate=${config.automate ? "yes" : "no"} control=${config.screenconnect ? "yes" : "no"})`,
);
