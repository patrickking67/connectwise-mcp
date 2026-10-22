// The HTTP surface of the Worker: one MCP endpoint, stateless, behind Access.
//
// Stateless on purpose. Every tool here is a function of its arguments and the
// environment, so each POST builds a fresh McpServer, narrows it to the caller
// (see entitlement.ts), answers, and lets it go. No Durable Object, no session
// id, no SSE stream to resume. The same createServer() the stdio entry point
// uses builds the tool surface, so the two cannot drift.
//
// Order of operations per request, and why it is this order:
//   1. route      - anything but POST /mcp (and GET /healthz) is answered without
//                   reading the body or touching credentials.
//   2. identify   - access.ts; fails closed when Access is not in front.
//   3. configure  - string bindings are copied to process.env so the vendor
//                   client reads its keys exactly as it does under stdio.
//   4. build      - createServer(), then the entitlement wrap for THIS caller.
//   5. serve      - a Streamable HTTP transport in JSON-response mode.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticate, type AccessContext, type AccessEnv } from './access.js';
import {
  applyEntitlement,
  decideEntitlement,
  registerSessionStatusTool,
  type EntitlementEnv,
} from './entitlement.js';

/** Bindings the Worker reads. Everything else in env is copied to process.env and otherwise ignored. */
export interface WorkerEnv extends AccessEnv, EntitlementEnv {
  readonly [binding: string]: unknown;
}

export interface WorkerOptions {
  /** The Worker name, used in logs, the realm and /healthz: "todyl-mcp". */
  readonly service: string;
  /** The tool name prefix: "todyl" gives todyl_session_status. */
  readonly toolPrefix: string;
  readonly version: string;
  /** Builds the vendor server. Called per request, after process.env is populated. */
  readonly buildServer: () => McpServer;
  /** Env var names whose values the status tool should echo (never secrets). */
  readonly gateVars?: readonly string[];
  /** Env var names that must NOT be set on a Worker (for example a LAN-only transport). */
  readonly forbiddenVars?: readonly string[];
}

const MCP_PATH = '/mcp';
const HEALTH_PATH = '/healthz';

/**
 * The vendor client reads configuration from process.env, exactly as it does
 * under stdio, so the string bindings are copied there. Bindings are constant
 * for the life of an isolate, so this is idempotent in production; it is also
 * what lets the tests drive the handler with a plain object.
 */
export function applyEnvironment(env: WorkerEnv): void {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') process.env[name] = value;
  }
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

export interface WorkerHandler {
  fetch(request: Request, env: WorkerEnv, ctx?: AccessContext): Promise<Response>;
}

export function createWorkerHandler(options: WorkerOptions): WorkerHandler {
  return {
    async fetch(request: Request, env: WorkerEnv, ctx?: AccessContext): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === HEALTH_PATH) {
        if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
        return json(200, {
          ok: true,
          service: options.service,
          version: options.version,
          access_binding: ctx?.access !== undefined && ctx?.access !== null,
          endpoint: `${url.origin}${MCP_PATH}`,
        });
      }
      if (url.pathname !== MCP_PATH) return json(404, { error: 'not_found', endpoint: `${url.origin}${MCP_PATH}` });
      if (request.method !== 'POST') {
        // Stateless JSON mode has no server-initiated stream to GET and no session to DELETE.
        return json(405, { error: 'method_not_allowed', message: 'This MCP endpoint accepts POST only.' }, { allow: 'POST' });
      }

      const auth = await authenticate(request, env, ctx, options.service);
      if (!auth.ok) return auth.response;

      const forbidden = (options.forbiddenVars ?? []).filter((name) => typeof env[name] === 'string' && env[name] !== '');
      if (forbidden.length > 0) {
        return json(503, {
          error: 'misconfigured',
          message: `These vars must not be set on the Worker: ${forbidden.join(', ')}. Remove them and redeploy.`,
        });
      }

      const entitlement = decideEntitlement(auth.identity, env);
      if (entitlement === undefined) {
        return json(403, {
          error: 'forbidden',
          message: `${auth.identity.email} is signed in but is not on MCP_READ_PRINCIPALS for ${options.service}.`,
        });
      }

      applyEnvironment(env);
      const server = options.buildServer();
      const summary = applyEntitlement(server, { service: options.service, identity: auth.identity, entitlement }, env);
      const gate: Record<string, string | undefined> = {};
      for (const name of options.gateVars ?? []) {
        const value = env[name];
        gate[name] = typeof value === 'string' ? value : undefined;
      }
      registerSessionStatusTool(server, `${options.toolPrefix}_session_status`, {
        service: options.service,
        version: options.version,
        identity: auth.identity,
        entitlement,
        summary,
        source: auth.source,
        gate,
      });

      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(request, {
        authInfo: {
          token: '',
          clientId: auth.identity.email,
          scopes: [entitlement.tier],
          extra: { email: auth.identity.email, tier: entitlement.tier, aud: auth.aud },
        },
      });
    },
  };
}
