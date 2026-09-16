# Repository agent instructions

Canonical instructions for every coding agent working in this repository
(Claude Code, Cursor, GitHub Copilot, Codex). Vendor files are thin adapters
that point here — never duplicate this content into them.

## Project overview

ConnectWise Manage MCP Server: ConnectWise PSA (Manage) plus optional Automate (RMM) and Control (ScreenConnect, beta) exposed to MCP clients. Runs as a remote streamable-HTTP server (stateless, horizontally scalable) or local stdio. Primary deploy target: Azure Container Apps via the Dockerfile; the app is host-portable.

## Tech stack

- TypeScript (strict, ESM, NodeNext), Node >= 20
- `@modelcontextprotocol/sdk` (McpServer, StreamableHTTPServerTransport stateless mode, StdioServerTransport)
- Express 5, Zod 3
- Vitest for tests

## Repo layout

- `src/index.ts` — HTTP entry: Express app, `/healthz`, `/mcp` + `/mcp/:token`, bearer/path-token auth (timing-safe), fresh server+transport per request, fail-closed startup guard, SIGTERM drain
- `manifest.json` — MCPB bundle manifest for the local stdio install; CI asserts it lists exactly the tools the server registers
- `infra/main.bicep` — the Azure Container Apps topology (see docs/deploying-azure.md)
- `src/stdio.ts` — local stdio entry
- `src/server.ts` — `createServer(config, deps)`; server instructions document PSA condition syntax
- `src/config.ts` — env parsing; `normalizePsaSite` adds the `api-` prefix for cloud hosts
- `src/lib/psa-client.ts` — PSA REST client: Basic auth (`companyId+publicKey:privateKey`), `clientId` header, 429 retry honoring Retry-After (capped), one 5xx retry, Link-header pagination, `CwApiError`
- `src/lib/automate-client.ts` — Automate client: token via `/cwa/api/v1/apitoken`, cached, refreshed on 401
- `src/lib/screenconnect-client.ts` — Control (ScreenConnect) client, BETA: forms-auth login + cookie/antiforgery, generic passthrough; endpoint shapes are version-dependent
- `src/tools/spec.ts` — the one way a tool is defined: `cw_` name convention, Title Case display titles, `read`/`write` kinds -> MCP annotations, `_meta` (MCP Apps `ui`, `openai/outputTemplate`, `anthropic/requiresUserInteraction`). `registerSpecTool` is the only registration path
- `src/tools/catalog.ts` — every tool spec, independent of configuration; the generated docs and the manifest are built from it
- `src/ui/ticket-card.ts` — the MCP Apps ticket card (`ui://connectwise-manage/ticket-card`, `text/html;profile=mcp-app`) and its resource registration
- `scripts/sync-tool-docs.ts` — regenerates `docs/TOOLS.md`, the README tool table and `manifest.json`'s tool list from the catalog
- `src/tools/psa.ts` — `SEARCHES` spec array drives the search tools; bespoke tools for ticket/company/time/expense/board workflows; `cw_api_request` (GET) and `cw_api_write` (guarded) escape hatches
- `src/tools/automate.ts` — Automate tools, registered only when configured
- `src/tools/screenconnect.ts` — Control tools (beta), registered only when `CW_SCREENCONNECT_*` is set
- `test/` — vitest; server tests run end-to-end through `InMemoryTransport` with injected `fetchImpl`

## Commands

- `npm run dev` — tsx watch on the HTTP entry
- `npm run build` — tsc to `dist/`
- `npm test` — vitest run
- `npm run typecheck` — tsc over src + test (tsconfig.test.json)
- `npm run mcpb:pack` — build the three per-product bundles (`dist/connectwise-{psa,automate,control}.mcpb`) from `manifests/`; `npm run mcpb:pack:suite` builds the all-in-one bundle from the root `manifest.json`; `npm run mcpb:validate` checks the root manifest
- `npm run start:remote` — run the HTTP entry from `dist/`
- `npm run docker:build` — build the remote transport's image
- `npm run tools:sync` / `npm run tools:check` — regenerate the tool docs from the catalog, or fail on drift (CI runs the check)

## Key conventions

- Tool results: `jsonResult()` (compact JSON, nulls stripped) and `errorResult()`; wrap handlers in `safeHandler` so API failures become tool errors, never protocol errors
- Search tools default to compact `fields` lists; `fields: "all"` returns full records — keep default field lists limited to names verified against the OpenAPI spec (`All.json` in the 2026.4 SDK download)
- Tool names are `cw_` + snake_case (`cw_automate_*` and `cw_control_*` for those modules). Display titles are Title Case and derived from the name; override `title` only when the derived one reads badly
- Never call `server.registerTool` directly — go through `registerSpecTool`, which is what guarantees a title, annotations on every tool, and the `_meta` a host needs
- Declare a `kind`: `read` gets `readOnlyHint`; `write` declares `destructive`/`idempotent` explicitly. Hosts gate on this (Microsoft 365 Copilot treats an unannotated tool as destructive), and Claude parallelizes only read-only calls
- Interactive tools are read or write tools that also declare a `ui://` resource and return `uiResult()` (text + `structuredContent`); the JSON path must keep working for hosts without MCP Apps
- New searchable PSA entities: add a `SEARCHES` entry, not a hand-rolled tool
- After touching any tool, run `npm run tools:sync` and commit the regenerated docs
- Inject `fetchImpl`/`sleep` through `ClientDeps` for testability; never hit the network in tests

## Security boundaries

- ConnectWise credentials are server-side env vars/secrets only — never log them, never return them in tool output
- `MCP_AUTH_TOKEN` gates the endpoint; comparisons are timing-safe; keep the path-token route working (claude.ai custom connectors cannot send headers)
- The HTTP entry **fails closed**: with neither `MCP_AUTH_TOKEN` nor Entra configured it exits non-zero rather than serving. `MCP_ALLOW_ANONYMOUS=true` overrides it for local testing only. Do not remove that guard — this server writes.
- Entra per-user auth (`src/lib/entra-auth.ts`): validates Entra v2 JWTs via jose when `AZURE_TENANT_ID`/`AZURE_CLIENT_ID` are set; serves `/.well-known/oauth-protected-resource`; coexists with the shared token — setup in docs/ENTRA_SETUP.md
- The read escape hatches (`cw_api_request`, `cw_automate_api_request`) issue GET only. `cw_api_write` must refuse DELETE without `confirm: true`, `cw_automate_api_write` refuses every call without it, and `cw_control_api_request` refuses POST without it — do not weaken these guardrails. Annotations are hints; these checks are the enforcement
- Do not deploy or push from this repo without being explicitly asked

## AI configuration maintenance

- This `AGENTS.md` is canonical. Update it only when durable repository knowledge
  changes, then re-sync the thin adapters (`CLAUDE.md`,
  `.github/copilot-instructions.md`).
- Use repository-shared files and remote HTTPS MCP servers only.
- Never commit `CLAUDE.local.md`, `.claude/settings.local.json`, or machine paths.
- Attribution: commits use only the repository owner's git identity. Never add an
  AI, bot, or assistant as author, co-author, committer, trailer, or reviewer.

## Definition of done

- Requested behavior is complete.
- `npm test`, `npm run typecheck`, and `npm run tools:check` pass.
- `npm run tools:sync` was run after any tool change and the regenerated docs
  are committed.
- Security guardrails (fail-closed startup, `confirm: true` gates, timing-safe
  token comparison) are intact.
