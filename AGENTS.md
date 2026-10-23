# Repository agent instructions

Canonical instructions for every coding agent working in this repository
(Claude Code, Cursor, GitHub Copilot, Codex). Vendor files are thin adapters
that point here — never duplicate this content into them.

## Project overview

ConnectWise MCP Server: ConnectWise PSA (Manage) plus optional Automate (RMM) exposed to MCP clients. (Control/ScreenConnect support was removed in 0.5.0.) Runs as a remote streamable-HTTP server (stateless, horizontally scalable) or local stdio. Primary deploy target: Azure Container Apps via the Dockerfile; the app is host-portable.

## Tech stack

- TypeScript (strict, ESM, NodeNext), Node >= 20
- `@modelcontextprotocol/sdk` (McpServer, StreamableHTTPServerTransport stateless mode, StdioServerTransport)
- Express 5, Zod 3
- Vitest for tests

## Repo layout

- `src/index.ts` — HTTP entry: Express app, `/healthz`, `/mcp` + `/mcp/:token`, bearer/path-token auth (timing-safe), fresh server+transport per request, fail-closed startup guard, SIGTERM drain
- `manifest.json` — MCPB bundle manifest for the local stdio install; CI asserts it lists exactly the tools the server registers
- `infra/main.bicep` — the Azure Container Apps topology (see docs/deploying-azure.md)
- `src/stdio.ts` — local stdio entry. It **always starts**, even with nothing configured or with a configuration that fails to load, so `cw_status_server` can explain what is missing; it used to exit, which is exactly the case a person needs help with
- `src/server.ts` — `createServer(config, deps, options)`; registers `cw_status_server` unconditionally, then each configured product's tools and views; server instructions document PSA condition syntax
- `src/config.ts` — env parsing; `normalizePsaSite` adds the `api-` prefix for cloud hosts
- `src/lib/psa-client.ts` — PSA REST client: Basic auth (`companyId+publicKey:privateKey`), `clientId` header, 429 retry honoring Retry-After (capped), one 5xx retry, Link-header pagination, `CwApiError`
- `src/lib/automate-client.ts` — Automate client: token via `/cwa/api/v1/apitoken`, cached, refreshed on 401. A 200 with no token is a refusal: the client reads keys case-insensitively, flags `IsTwoFactorRequired` (fix: tick Integrator on the Automate user), and reports the server `Message` and reply field names, never values
- `src/lib/totp.ts` — RFC 6238 TOTP on `node:crypto` only (base32 decode, HOTP, 30s step, 6 digits, SHA-1) plus `looksLikeTwoFactorChallenge`. Used when the Automate login account keeps two-factor enabled; the preferred answer is still a dedicated API service account exempt from 2FA
- `src/tools/gate.ts` — the per-product write gate (`CW_PSA_MODE` / `CW_AUTOMATE_MODE` = `write`, `CW_*_ALLOW_DESTRUCTIVE=true` for `destructive` specs, `confirm: true` on every write call), bound per server with `bindGates`; `registerSpecTool` applies it to every `kind: "write"` tool, and `cw_status_gate` reports it
- `src/tools/spec.ts` — the one way a tool is defined: `cw_` name convention, Title Case display titles, `read`/`write` kinds -> MCP annotations, `_meta` (MCP Apps `ui`, `openai/outputTemplate`, `anthropic/requiresUserInteraction`). `registerSpecTool` is the only registration path, and it injects `confirm` and the gate check into every write tool
- `src/tools/catalog.ts` — every tool spec, independent of configuration; the generated docs and the manifest are built from it
- `src/version.ts` — `SERVER_NAME` / `SERVER_VERSION`, the one place the version is written
- `src/tools/status.ts` — `cw_status_server` and `cw_status_gate`, registered whatever is configured; reports missing env vars with their Claude Desktop **Settings → Extensions** field titles
- `src/apps/shell.ts` — the MCP Apps view shell: `BASE_CSS`, `BOOT_JS`, `renderPage`, `viewSpec`, `registerView`. Every view is one self-contained themed HTML document (light and dark), no CDN
- `src/apps/generated/runtime.ts` — GENERATED: the inlined `@modelcontextprotocol/ext-apps` browser runtime. Regenerate with `npm run apps:runtime`; `npm run apps:check` fails when stale
- `src/apps/views/*.ts` — the views. PSA: `ticket` (`cw_get_ticket`, with the add-note box and the `window.openai` ChatGPT fallback), `board`, `company`, `time`, `project`, `schedule`. Automate: `automate-fleet`, `automate-computers`, `automate-computer` (Run script / Reboot buttons calling the gated tools with `confirm: true` after an inline second click), `automate-client`
- `scripts/sync-tool-docs.ts` — regenerates `docs/TOOLS.md`, the README tool table and `manifest.json`'s tool list from the catalog
- `src/tools/psa.ts` — `SEARCHES` spec array drives the search tools; bespoke tools for ticket/company/time/expense/board workflows; `cw_api_get` (GET) and `cw_api_write` (guarded) escape hatches
- `src/tools/automate.ts` — Automate tools, registered only when configured. Every endpoint is in the published Automate REST API (swagger cited in the file header) and every GET was confirmed live; Automate has no endpoint to acknowledge/clear alerts or edit a computer, so there is no tool for either. Computer `Id`s come back as strings — id params use `z.coerce.number()`. `AutomateClient.list()` is the paged list helper (`hasMore` inferred from a full page)
- `test/` — vitest; server tests run end-to-end through `InMemoryTransport` with injected `fetchImpl`

## Commands

- `npm run dev` — tsx watch on the HTTP entry
- `npm run build` — tsc to `dist/`
- `npm test` — vitest run
- `npm run typecheck` — tsc over src + test (tsconfig.test.json)
- `npm run apps:runtime` / `npm run apps:check` — regenerate / verify the inlined MCP Apps browser runtime
- `npm run mcpb:pack` — build the two per-product bundles (`dist/connectwise-{psa,automate}.mcpb`) from `manifests/`; `npm run mcpb:pack:suite` builds the all-in-one bundle from the root `manifest.json`; `npm run mcpb:validate` checks the root manifest
- `npm run start:remote` — run the HTTP entry from `dist/`
- `npm run docker:build` — build the remote transport's image
- `npm run tools:sync` / `npm run tools:check` — regenerate the tool docs from the catalog, or fail on drift (CI runs the check)

## Key conventions

- Tool results: `jsonResult()` (compact JSON, nulls stripped) and `errorResult()`; wrap handlers in `safeHandler` so API failures become tool errors, never protocol errors
- Search tools default to compact `fields` lists; `fields: "all"` returns full records — keep default field lists limited to names verified against the OpenAPI spec (`All.json` in the 2026.4 SDK download)
- Tool names are `<prefix>_<verb>_<noun>`: `cw_` + snake_case (`cw_automate_*` for Automate). **The verb declares the kind** — reads use `list`/`get`/`search`/`find`/`test`/`status`/`report`/`plan`, writes use `create`/`update`/`set`/`run`/`send`/`add`/… , and `view` is reserved for interactive views and nothing else. The raw passthroughs are `*_api_get` (read) and `*_api_write` (write). `test/tool-contract.test.ts` enforces this; renaming a tool means adding a row to `docs/tool-renames.md`
- Display titles are Title Case and derived from the name; override `title` only when the derived one reads badly
- Never call `server.registerTool` directly — go through `registerSpecTool`, which is what guarantees a title, annotations on every tool, and the `_meta` a host needs
- Declare a `kind`: `read` gets `readOnlyHint`; `write` declares `destructive`/`idempotent` explicitly. Hosts gate on this (Microsoft 365 Copilot treats an unannotated tool as destructive), and Claude parallelizes only read-only calls
- Interactive tools are read tools that also declare a `ui://connectwise/<view>.html` resource and return `uiResult()` (text + `structuredContent`); the JSON path must keep working for hosts without MCP Apps
- Add a view by writing a `ViewDefinition` under `src/apps/views/` and registering it through `registerView` — never hand-roll a resource. Keep it one document: no CDN, no framework, theme-aware in light **and** dark, header counts, filterable/sortable tables, `.empty`/`.error` states. Buttons in a view may only call this server's own guarded write tools
- New searchable PSA entities: add a `SEARCHES` entry, not a hand-rolled tool
- After touching any tool, run `npm run tools:sync` and commit the regenerated docs
- Inject `fetchImpl`/`sleep` through `ClientDeps` for testability; never hit the network in tests

## Security boundaries

- ConnectWise credentials are server-side env vars/secrets only — never log them, never return them in tool output
- `MCP_AUTH_TOKEN` gates the endpoint; comparisons are timing-safe; keep the path-token route working (claude.ai custom connectors cannot send headers)
- The HTTP entry **fails closed**: with neither `MCP_AUTH_TOKEN` nor Entra configured it exits non-zero rather than serving. `MCP_ALLOW_ANONYMOUS=true` overrides it for local testing only. Do not remove that guard — this server writes.
- Entra per-user auth (`src/lib/entra-auth.ts`): validates Entra v2 JWTs via jose when `AZURE_TENANT_ID`/`AZURE_CLIENT_ID` are set; serves `/.well-known/oauth-protected-resource`; coexists with the shared token — setup in docs/ENTRA_SETUP.md
- The read escape hatches (`cw_api_get`, `cw_automate_api_get`) issue GET only. Every write tool goes through the write gate: refused unless the product is in write mode, refused for a `destructive` spec unless ALLOW_DESTRUCTIVE is set, refused without `confirm: true`; the raw `*_api_write` tools are `destructive`. `cw_automate_run_command` also applies the disruptive tier dynamically by command name (`DISRUPTIVE_COMMAND`). Do not weaken these guardrails. Annotations are hints; these checks are the enforcement
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
- The server starts with **no** environment set and answers `tools/list` with
  `cw_status_server` and `cw_status_gate`; a partly configured product fails with a message naming the
  missing variables and their Settings → Extensions fields.
- Security guardrails (fail-closed startup, the per-product write gate and
  `confirm: true`, timing-safe token comparison) are intact.
