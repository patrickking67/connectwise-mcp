// Cloudflare Worker entry point for ConnectWise Automate: the stdio tool surface,
// behind Cloudflare Access (Managed OAuth), narrowed per caller. See handler.ts for
// the request flow, access.ts for identity and entitlement.ts for the tiers.
//
// A separate Worker from the PSA one (index.ts), deployed with
// wrangler.automate.jsonc, so each product is its own connector, as the two
// per-product MCPB bundles are. Credentials are an Automate integrator login, set
// as Worker secrets (CW_AUTOMATE_URL, CW_AUTOMATE_USERNAME, CW_AUTOMATE_PASSWORD,
// CW_AUTOMATE_CLIENT_ID). The PSA variables are not set here, so only Automate
// registers. An integrator login is exempt from two-factor; CW_AUTOMATE_TOTP_SECRET
// is needed only for a login that keeps it.

import { loadConfig, type AppConfig } from "../config.js";
import { createServer } from "../server.js";
import { SERVER_VERSION } from "../version.js";
import { createWorkerHandler } from "./handler.js";

export default createWorkerHandler({
  service: "connectwise-automate-mcp",
  toolPrefix: "cw",
  version: SERVER_VERSION,
  gateVars: ["CW_AUTOMATE_URL", "CW_AUTOMATE_MODE", "CW_AUTOMATE_ALLOW_DESTRUCTIVE"],
  buildServer: () => {
    // Mirrors index.ts: a configuration problem becomes a server whose status
    // tool explains it, not a crash the client sees as a dead connector.
    let config: AppConfig = { port: 8080 };
    let configError: string | undefined;
    try {
      config = loadConfig();
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
    }
    return createServer(config, {}, configError === undefined ? {} : { configError });
  },
});
