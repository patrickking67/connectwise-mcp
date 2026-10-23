#!/usr/bin/env node
// Put this Worker behind a Cloudflare Access application with Managed OAuth.
//
// Idempotent: run it after every deploy if you like. It reads the Worker name
// and account from wrangler.jsonc, finds the Worker's immutable id, then creates
// or updates one self-hosted Access application that targets the Worker itself
// (destination type "worker", so workers.dev, the custom domain and previews are
// all covered) with Managed OAuth turned on. Access then acts as the OAuth
// authorization server for MCP clients: discovery, dynamic client registration,
// the login against your identity provider, and token issuance all happen in
// Access, never in the Worker.
//
// It also creates (or reuses) one reusable Access policy and attaches it. The
// default rule admits every email in --allow-domain; --allow-emails narrows it to
// a list. Who may WRITE is not decided here: that is the MCP_*_PRINCIPALS vars on
// the Worker (see docs/deploy-cloudflare.md).
//
// Needs CLOUDFLARE_API_TOKEN with these permissions on the account:
//   Access: Apps and Policies Write, Access: Organizations Read,
//   Workers Scripts Read.
// The wrangler OAuth login does not carry the Access scopes, which is why this is
// a token and not `wrangler`.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... node scripts/access-app.mjs [--allow-domain divergeit.com]
//       [--allow-emails a@x.com,b@x.com] [--session 24h] [--token-lifetime 15m]
//       [--redirect https://extra.example/callback ...] [--dry-run]

import { readFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';

// Redirect URIs the MCP clients we use register with. Anything on localhost or
// the loopback address is allowed too, for CLI clients.
const DEFAULT_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://playground.ai.cloudflare.com/*',
  'https://inspector.modelcontextprotocol.io/*',
];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
function args(name) {
  const out = [];
  process.argv.forEach((value, index) => { if (value === name && process.argv[index + 1]) out.push(process.argv[index + 1]); });
  return out;
}
const DRY_RUN = process.argv.includes('--dry-run');

function stripJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
}

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('CLOUDFLARE_API_TOKEN is not set. Create a token with Access: Apps and Policies Write, Access: Organizations Read and Workers Scripts Read on the account.');
  process.exit(2);
}

const wrangler = JSON.parse(stripJsonComments(readFileSync('wrangler.jsonc', 'utf8')));
const accountId = wrangler.account_id;
const workerName = wrangler.name;
const customDomain = (wrangler.routes ?? []).find((route) => route.custom_domain)?.pattern;
if (!accountId || !workerName) throw new Error('wrangler.jsonc needs account_id and name');

async function cf(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.success === false) {
    const errors = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || response.statusText;
    throw new Error(`${method} ${path} -> ${response.status} ${errors}`);
  }
  return json.result;
}

async function listAll(path) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const result = await cf('GET', `${path}${sep}page=${page}&per_page=50`);
    if (!Array.isArray(result)) return Array.isArray(result?.items) ? result.items : out;
    out.push(...result);
    if (result.length < 50) return out;
  }
}

// 1. A Zero Trust organization must exist; Access cannot be configured without one.
const org = await cf('GET', `/accounts/${accountId}/access/organizations`).catch((error) => {
  throw new Error(`No Zero Trust organization is readable on account ${accountId}. Create one at one.dash.cloudflare.com (choose a team name) and check the token has Access: Organizations Read. ${error.message}`);
});
const teamDomain = org?.auth_domain ?? org?.name;
console.log(`Zero Trust organization: ${org?.name ?? '(unnamed)'} (${teamDomain})`);

// 2. The Worker's immutable id, which is what the "worker" destination wants.
const workers = await listAll(`/accounts/${accountId}/workers/workers`);
const worker = workers.find((entry) => entry.name === workerName);
if (!worker) throw new Error(`Worker ${workerName} is not deployed on account ${accountId}. Run npm run worker:deploy first.`);
console.log(`Worker ${workerName}: id ${worker.id}`);

// 3. One reusable policy.
const allowDomain = arg('--allow-domain', 'divergeit.com');
const allowEmails = (arg('--allow-emails', '') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
const policyName = `${workerName} users`;
const include = allowEmails.length > 0
  ? allowEmails.map((email) => ({ email: { email } }))
  : [{ email_domain: { domain: allowDomain } }];
const policyBody = { name: policyName, decision: 'allow', include, exclude: [], require: [], session_duration: arg('--session', '24h') };
const policies = await listAll(`/accounts/${accountId}/access/policies`);
let policy = policies.find((entry) => entry.name === policyName);
if (DRY_RUN) console.log(`[dry-run] policy ${policyName}:`, JSON.stringify(policyBody));
else if (policy) {
  policy = await cf('PUT', `/accounts/${accountId}/access/policies/${policy.id}`, policyBody);
  console.log(`Policy ${policyName}: updated (${policy.id})`);
} else {
  policy = await cf('POST', `/accounts/${accountId}/access/policies`, policyBody);
  console.log(`Policy ${policyName}: created (${policy.id})`);
}

// 4. The application, targeting the Worker, with Managed OAuth.
const appBody = {
  name: workerName,
  type: 'self_hosted',
  destinations: [{ type: 'worker', worker_id: worker.id }],
  session_duration: arg('--session', '24h'),
  app_launcher_visible: false,
  auto_redirect_to_identity: false,
  http_only_cookie_attribute: true,
  policies: policy ? [policy.id] : [],
  oauth_configuration: {
    enabled: true,
    dynamic_client_registration: {
      enabled: true,
      allow_any_on_localhost: true,
      allow_any_on_loopback: true,
      allowed_uris: [...DEFAULT_REDIRECTS, ...args('--redirect')],
    },
    grant: {
      access_token_lifetime: arg('--token-lifetime', '15m'),
      session_duration: arg('--grant-session', '336h'),
    },
  },
};
const apps = await listAll(`/accounts/${accountId}/access/apps`);
let app = apps.find((entry) => entry.name === workerName || (entry.destinations ?? []).some((d) => d.type === 'worker' && d.worker_id === worker.id));
if (DRY_RUN) {
  console.log(`[dry-run] application ${workerName}:`, JSON.stringify(appBody, null, 2));
} else if (app) {
  app = await cf('PUT', `/accounts/${accountId}/access/apps/${app.id}`, appBody);
  console.log(`Access application ${workerName}: updated (${app.id}, aud ${app.aud})`);
} else {
  app = await cf('POST', `/accounts/${accountId}/access/apps`, appBody);
  console.log(`Access application ${workerName}: created (${app.id}, aud ${app.aud})`);
}

const hosts = [customDomain, `${workerName}.<subdomain>.workers.dev`].filter(Boolean);
console.log('\nMCP endpoint(s):');
for (const host of hosts) console.log(`  https://${host}/mcp`);
if (customDomain) console.log(`OAuth discovery:\n  https://${customDomain}/.well-known/oauth-authorization-server`);
console.log(`\nIf you later front the hostname with a classic Access application instead of the Worker destination,\nset these Worker vars so the JWT fallback can verify the assertion:\n  ACCESS_TEAM_DOMAIN=${teamDomain}\n  ACCESS_AUD=${app?.aud ?? '<aud>'}`);
