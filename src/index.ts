import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { entraIssuer, verifyEntraToken } from "./lib/entra-auth.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

/** How long a drain may take before the process leaves anyway. */
const SHUTDOWN_GRACE_MS = 10_000;

const config = loadConfig();

// Fail closed. This connector does not only read: it can create and update
// tickets, add notes, and create time and expense entries, and it carries raw
// request escape hatches for all three products. An endpoint that serves those to
// anyone who finds the URL is not a degraded deployment of it — it is a different
// and unacceptable one.
//
// The stdio entry deliberately does not do this. There the operating system's user
// account is the boundary, and a client launches the process before anyone has
// configured anything. A container that cannot authenticate anybody should not
// report itself healthy.
if (!config.authToken && !config.entra) {
  if (process.env.MCP_ALLOW_ANONYMOUS === "true") {
    console.error(
      "WARNING: no MCP_AUTH_TOKEN and no Entra configuration — this endpoint is UNAUTHENTICATED and can WRITE to ConnectWise. This is only ever acceptable on a local, non-routable test run.",
    );
  } else {
    console.error(
      "Refusing to start an unauthenticated remote server. Set MCP_AUTH_TOKEN, or set AZURE_TENANT_ID and AZURE_CLIENT_ID for Entra ID per-user authentication. MCP_ALLOW_ANONYMOUS=true overrides this for local testing only.",
    );
    process.exit(1);
  }
}

const app = express();
app.disable("x-powered-by");
// Behind Container Apps ingress: honor x-forwarded-proto/host for absolute URLs.
app.set("trust proxy", true);
app.use(express.json({ limit: "4mb" }));

function tokenMatches(provided: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function baseUrl(req: express.Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

const requireAuth: express.RequestHandler = async (req, res, next) => {
  if (!config.authToken && !config.entra) return next();
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const pathToken = typeof req.params.token === "string" ? req.params.token : undefined;
  const provided = bearer ?? pathToken;
  if (config.authToken && provided && tokenMatches(provided, config.authToken)) return next();
  if (config.entra && bearer) {
    try {
      await verifyEntraToken(bearer, config.entra);
      return next();
    } catch {
      // invalid/expired JWT — fall through to the 401 challenge
    }
  }
  const challenge = config.entra
    ? `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`
    : "Bearer";
  res.status(401).set("WWW-Authenticate", challenge).json({ error: "Unauthorized" });
};

// RFC 9728 protected-resource metadata: lets OAuth-capable MCP clients
// (claude.ai, Claude Code) discover that Entra ID is the authorization server.
const resourceMetadata: express.RequestHandler = (req, res) => {
  if (!config.entra) {
    res.status(404).json({ error: "OAuth is not configured on this server" });
    return;
  }
  res.json({
    resource: `${baseUrl(req)}/mcp`,
    authorization_servers: [entraIssuer(config.entra)],
    scopes_supported: [`api://${config.entra.clientId}/access_as_user`],
    bearer_methods_supported: ["header"],
  });
};

// Stateless streamable HTTP: a fresh server+transport per request, no session
// affinity, so any number of replicas can serve any request.
const handleMcp: express.RequestHandler = async (req, res) => {
  const server = createServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
};

const methodNotAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed: this server runs in stateless mode" },
    id: null,
  });
};

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
});

app.get(
  ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
  resourceMetadata,
);

app.post(["/mcp", "/mcp/:token"], requireAuth, handleMcp);
app.all(["/mcp", "/mcp/:token"], methodNotAllowed);

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on :${config.port}`);
  console.log(`  PSA (Manage) tools:  ${config.psa ? `enabled (${config.psa.site})` : "disabled — set CW_PSA_* env vars"}`);
  console.log(`  Automate tools:      ${config.automate ? `enabled (${config.automate.baseUrl})` : "disabled — set CW_AUTOMATE_* env vars"}`);
  console.log(`  Entra per-user auth:  ${config.entra ? `enabled (tenant ${config.entra.tenantId})` : "disabled — set AZURE_TENANT_ID + AZURE_CLIENT_ID"}`);
});

// Container Apps sends SIGTERM and then waits before killing the container.
// Without this the process dies immediately as PID 1 and any request in flight is
// severed mid-response, which the caller sees as a network error rather than as a
// deploy. That matters more here than on a read-only connector: a severed write is
// ambiguous, and the caller cannot tell whether the ticket was created.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.error(`${signal} received; draining connections`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  });
}
