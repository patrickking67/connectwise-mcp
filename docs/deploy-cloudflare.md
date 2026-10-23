# Deploy to Cloudflare Workers behind Cloudflare Access

The Worker in `src/worker/` serves the same tool surface as the stdio server over
stateless Streamable HTTP, behind a Cloudflare Access application with Managed
OAuth. One Worker, one hostname, one set of vendor credentials; who may do what
is decided per caller from their Access identity.

| | |
|---|---|
| Worker | `connectwise-psa-mcp` in the **DivergeIT Consulting** account (`575e64e08663d68598105d82793c88ff`) |
| Endpoint | `https://connectwise-psa-mcp.divergeitconsulting.com/mcp` (also `https://connectwise-psa-mcp.divergeitconsulting.workers.dev/mcp`) |
| Health | `GET /healthz`, public, no identity |
| Auth | Cloudflare Access, Managed OAuth. The Worker holds no OAuth code and no client list. |
| Tiers | read, write, destructive, from `MCP_*_PRINCIPALS` vars; `cw_session_status` explains the current session |
| Entry | `src/worker/index.ts`; shared layer in `access.ts`, `entitlement.ts`, `handler.ts` |

## How a request is handled

1. **Route.** Only `POST /mcp` reaches the server. `GET /healthz` answers without
   identity. Anything else is 404 or 405 before the body is read.
2. **Identify.** `access.ts` reads the caller from `ctx.access.getIdentity()`, which
   Access populates when its application targets the Worker. If that binding is
   absent and a `Cf-Access-Jwt-Assertion` header is present (a classic Access
   application on the hostname), the JWT is verified against the team JWKS with
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Neither present: **503**, never an
   anonymous session.
3. **Entitle.** `entitlement.ts` gives the caller a tier. Everyone Access admits can
   read. `MCP_WRITE_PRINCIPALS` and `MCP_DESTRUCTIVE_PRINCIPALS` widen that:
   comma-separated emails, `@domains`, or Access group names (`group:Name` or the
   bare name). `MCP_READ_PRINCIPALS`, when set, turns the server deny-by-default.
4. **Narrow.** Every tool is classified from its MCP annotations (`readOnlyHint`
   true is read, `destructiveHint` true is destructive, anything else is write;
   no annotations fails closed to write). Tools above the caller's tier are hidden
   from `tools/list` (`MCP_HIDE_UNENTITLED_TOOLS=false` keeps them listed) and
   refused if called, with the var to change named in the refusal.
5. **Serve.** The vendor gate vars (`CW_PSA_MODE`, `CW_PSA_ALLOW_DESTRUCTIVE`
   where the server has them) remain in force inside every tool. They are the
   ceiling for all callers; the tiers narrow per caller underneath.
6. **Log.** One JSON line per tool call in Workers Logs: tool, tool tier, caller,
   caller tier, outcome (`ok`, `tool_error`, `error`, `refused`), duration, and the
   argument **names**. Never argument values.

## Deploy

```bash
npm ci
npm test                      # includes test/worker.test.*
npm run worker:check          # bundle under wrangler without uploading
npm run worker:deploy         # build, then wrangler deploy
```

`wrangler.jsonc` carries the account, the custom domain route, observability and
the plain vars. Secrets are set once:

```bash
# one at a time
npx wrangler secret put CW_PSA_PRIVATE_KEY
# or all at once from a JSON file that never enters the repo
npx wrangler secret bulk /path/to/secrets.json
```

Secrets this Worker reads: `CW_PSA_SITE`, `CW_PSA_COMPANY_ID`, `CW_PSA_PUBLIC_KEY`, `CW_PSA_PRIVATE_KEY`, `CW_PSA_CLIENT_ID` (PSA only; Automate stays unconfigured on this Worker).

### The Automate Worker

Automate is a second Worker, `connectwise-automate-mcp` on
`connectwise-automate-mcp.divergeitconsulting.com`, built from `src/worker/automate.ts` and
configured by `wrangler.automate.jsonc`, so each product is its own connector. Deploy it
with `npm run worker:deploy:automate`, and pass `--config wrangler.automate.jsonc` to every
`wrangler secret` command for it. Secrets it reads: `CW_AUTOMATE_URL`,
`CW_AUTOMATE_USERNAME`, `CW_AUTOMATE_PASSWORD`, `CW_AUTOMATE_CLIENT_ID`; use an integrator
login, which is exempt from two-factor. It is read-only until `CW_AUTOMATE_MODE=write` is
added to its vars. It needs its own Access application, set up as below.

## Put it behind Access (once per Worker)

Access needs a Zero Trust organization (a team name) on the account. Then:

```bash
CLOUDFLARE_API_TOKEN=... npm run access:setup -- --allow-domain divergeit.com
```

The token needs **Access: Apps and Policies Write**, **Access: Organizations Read**
and **Workers Scripts Read** on the DivergeIT Consulting account (the wrangler OAuth
login does not carry the Access scopes). The script is idempotent: it finds the
Worker's id, creates or updates one reusable policy (`connectwise-psa-mcp users`) and one
self-hosted application targeting the Worker with Managed OAuth and dynamic
client registration enabled, and prints the endpoint and discovery URL. Use
`--allow-emails a@divergeit.com,b@divergeit.com` to admit a list instead of a
domain, `--redirect https://...` to allow another client's callback, `--dry-run`
to print the request bodies without sending them.

Dashboard route, if you prefer: Zero Trust → Access → Applications → Add → Self-hosted
→ destination type **Worker** → pick `connectwise-psa-mcp` → policy → enable **Managed OAuth**
(dynamic client registration on, add the client redirect URIs listed in
`scripts/access-app.mjs`).

## Connect a client

Give the client the endpoint URL and nothing else:

| Client | Where |
|---|---|
| Claude.ai / Claude Desktop | Settings → Connectors → Add custom connector → `https://connectwise-psa-mcp.divergeitconsulting.com/mcp` |
| Claude Code | `claude mcp add --transport http connectwise-psa-mcp https://connectwise-psa-mcp.divergeitconsulting.com/mcp` |
| MCP Inspector / Workers AI Playground | paste the URL |

The client discovers Access as the authorization server, registers itself, and
sends the user to the identity provider. On first use, call
`cw_session_status` to see the tier the server gave you and what it hides.

## Grant write access

Edit `vars` in `wrangler.jsonc` (or `wrangler deploy --var`):

```jsonc
"MCP_WRITE_PRINCIPALS": "patrickk@divergeit.com, group:MCP Operators",
"MCP_DESTRUCTIVE_PRINCIPALS": "patrickk@divergeit.com"
```

Group names come from the identity provider through Access; the Access
application's identity shows them, as does the `groups` field of the status tool.
Destructive implies write. Nothing here lifts the vendor gate: with
`CW_PSA_MODE=read` on the Worker, nobody writes.

## Local

```bash
npm run worker:dev
```

`wrangler dev` simulates Access with the identity in the `access.dev` block of
`wrangler.jsonc`, so `http://localhost:8787/mcp` works without a tunnel. Put the
vendor secrets in `.dev.vars` (gitignored).

## What is deliberately not here

- **No per-user vendor credentials.** Every caller shares the Worker's secrets;
  the tiers decide what they may do with them. Per-user vendor keys would need a
  store and a consent flow, and no client we use would benefit today.
- **No sessions, no Durable Object.** Each POST builds a fresh server. Nothing to
  resume, nothing to leak between callers.
- **No bearer token of our own.** Access tokens are Access's; the Worker never sees
  a secret it has to compare.
