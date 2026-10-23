// Cloudflare Worker entry point: the stdio tool surface, behind Cloudflare
// Access (Managed OAuth), narrowed per caller. See handler.ts for the request
// flow, access.ts for identity and entitlement.ts for the tiers.
//
// This Worker is the PSA (Manage) surface. Credentials are the integrator's
// ConnectWise PSA keys, set as Worker secrets (CW_PSA_SITE, CW_PSA_COMPANY_ID,
// CW_PSA_PUBLIC_KEY, CW_PSA_PRIVATE_KEY, CW_PSA_CLIENT_ID). Automate registers
// only when its variables are set, and they are not set here. Every
// caller Access admits shares the PSA member; what differs per caller is the
// tool tier.
//
// This is a second remote entry point beside index.ts (the Express server with
// Entra bearer auth, for container hosting). They share createServer().

import { loadConfig, type AppConfig } from "../config.js";
import { createServer } from "../server.js";
import { SERVER_VERSION } from "../version.js";
import { createWorkerHandler, type WorkerEnv } from "./handler.js";

export type { WorkerEnv };

export default createWorkerHandler({
  service: "connectwise-psa-mcp",
  toolPrefix: "cw",
  version: SERVER_VERSION,
  gateVars: ["CW_PSA_SITE", "CW_PSA_COMPANY_ID"],
  buildServer: () => {
    // Mirrors stdio.ts: a configuration problem becomes a server whose status
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
