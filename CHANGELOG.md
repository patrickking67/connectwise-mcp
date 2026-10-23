# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-22

### Added
- **A per-product write gate.** Every write tool stays listed but refuses until
  the operator opens it: `CW_PSA_MODE=write` / `CW_AUTOMATE_MODE=write` (Settings
  fields "PSA write mode" / "Automate write mode"), plus
  `CW_PSA_ALLOW_DESTRUCTIVE=true` / `CW_AUTOMATE_ALLOW_DESTRUCTIVE=true` for the
  disruptive tier (raw `*_api_write`, reboots, uninstalls, schedule deletes,
  disruptive agent commands). Every write call also needs `confirm: true`. A
  refusal names the env var and Settings field and says nothing was changed.
  `cw_status_gate` reports the gate for each product.
- **Automate, built out (7 to 45 tools in its bundle).** Reads across computers
  (software, services, drives, alerts, monitors, patching, hardware, script and
  command history), clients, locations, contacts, groups, scripts and schedules,
  running scripts, alerts, monitors, agent commands, tickets, users, network
  devices and patch history, plus `cw_automate_test_connection`. Gated writes:
  `cw_automate_run_script`, `cw_automate_run_command`,
  `cw_automate_run_shell_command`, `cw_automate_update_client`,
  `cw_automate_update_location`; disruptive tier `cw_automate_reboot_computer`,
  `cw_automate_delete_script_schedule`, `cw_automate_uninstall_software`. Every
  endpoint is in the published Automate REST API and every read was confirmed
  read-only against a live server. Automate exposes no endpoint to acknowledge
  or clear an alert or edit a computer, so there is no tool for either.
- **Three Automate views:** `cw_automate_view_fleet` (offline servers, pending
  reboots, quiet agents, stale AV, per client), `cw_automate_view_client` and
  `cw_automate_view_computer` (drives, patching, alerts, history, with Run
  script and Reboot buttons that call the gated tools after a second click).
- **PSA gaps:** `cw_get_configuration`, `cw_get_contact`, `cw_get_project`
  (phases, team, ticket progress), `cw_get_purchase_order` (with line items),
  `cw_search_catalog_items`, `cw_search_products`, and the `cw_view_project`
  and `cw_view_schedule` views.

### Changed
- **PSA writes now need write mode.** Existing installs that create tickets,
  notes, time or expenses must set "PSA write mode" (`CW_PSA_MODE=write`);
  until then those tools refuse with that instruction. `cw_api_write` also
  needs "PSA allow destructive".
- `cw_update_ticket` is a non-destructive write (it was annotated destructive).

### Removed
- **ConnectWise Control (ScreenConnect).** `cw_control_list_sessions`,
  `cw_control_api_write`, `cw_control_view_sessions`, the `CW_SCREENCONNECT_*`
  settings and the `connectwise-control` bundle are gone, along with the
  remote-support skill.

### Fixed
- **Automate login that returned 200 with no token.** The client reported only
  "returned no AccessToken". It now reads the token case-insensitively, names a
  two-factor demand (`IsTwoFactorRequired`) and the fix (tick Integrator on the
  Automate user, or set the TOTP seed), calls out an HTML reply as a wrong URL,
  and otherwise includes the server message and the reply's field names.
- The CI manifest check compared tool names against titles; it now compares
  titles to titles.

## [0.4.0] - 2026-09-22

### Added
- **`cw_status_server`, and a server that always starts.** The stdio entry used
  to exit when no ConnectWise product was configured — which is exactly the case
  a person needs help with, because Claude Desktop then shows only "server
  disconnected". It now starts whatever is configured, registering
  `cw_status_server`, which reports which products are on, how many tools are
  registered, and for anything missing the exact environment variables *and the
  Settings → Extensions field titles they come from*.
- **Five new interactive views**, on a shared MCP Apps shell (`src/apps/shell.ts`)
  with the `@modelcontextprotocol/ext-apps` browser runtime inlined, so a view is
  one self-contained HTML document with no CDN and no framework, correct in light
  and dark: `cw_view_board` (a board's queue, a row opens the ticket card inline),
  `cw_view_company` (contacts, configurations, open tickets, agreements),
  `cw_view_time` (time entries rolled up per member),
  `cw_automate_view_computers` and `cw_control_view_sessions`. The ticket card
  (`cw_get_ticket`) moved onto the same shell, keeping its internal-note box and
  gaining a `window.openai` fallback so it renders in ChatGPT too.
- **Optional two-factor (TOTP) support for Automate and Control.** Both products
  can require a second factor on the account an integration logs in as, which no
  username/password login can satisfy headlessly — the real reason those two have
  never worked against instances whose admin accounts carry 2FA. Set the optional
  `automate_totp_secret` / `screenconnect_totp_secret` field
  (`CW_AUTOMATE_TOTP_SECRET`, `CW_SCREENCONNECT_TOTP_SECRET`) to the seed the
  account's authenticator was enrolled with and the connector generates each code
  itself: Automate sends it as `TwoFactorPasscode` on the token request, Control
  as the one-time password in `TryLogin`. RFC 6238 in `src/lib/totp.ts`, on
  `node:crypto` alone and tested against the RFC vectors — no new dependency. When
  a product demands a second factor and no seed is set, the error now says so and
  names the field instead of reporting a generic authentication failure. The
  cleaner alternative, a dedicated API service account exempt from two-factor, is
  documented in `docs/SETUP.md`.
- `docs/mcp-clients.md`: installing this server in Claude Desktop, Claude Code,
  claude.ai/mobile (via the Azure Container App), ChatGPT desktop and Codex,
  Cursor, Windsurf and VS Code — with the absolute-path note each one needs.
- `docs/tool-renames.md`: the old → new name table.
- A tool-name contract test: every name is `<prefix>_<verb>_<noun>`, the verb
  matches the tool's kind, `view` appears only on a view, and every view carries
  a `ui://` resource under both the MCP Apps and the ChatGPT key.

### Changed
- **Tool renames** (see `docs/tool-renames.md`): `cw_system_info` →
  `cw_status_system`, `cw_api_request` → `cw_api_get`,
  `cw_automate_api_request` → `cw_automate_api_get`, `cw_control_api_request` →
  `cw_control_api_write` (it was already classified as a write, because Control
  answers reads over POST; the name now says so).
- A partly configured **Automate or Control** product now fails loudly with the
  missing variables named, exactly as PSA already did. Previously a half-filled
  Automate form was silently ignored, so the extension looked broken with no
  explanation. Every product bundle lists `cw_status_server` alongside its own
  tools.
- Bundle icons refreshed from `mcp-logos/transparent/`: PSA now carries the
  ConnectWise Manage compass; Automate and Control keep the corporate CW mark.

## [0.3.1] - 2026-09-16

### Added
- One bundle per product. `npm run mcpb:pack` builds `connectwise-psa.mcpb`,
  `connectwise-automate.mcpb` and `connectwise-control.mcpb` from the manifests
  under `manifests/`, each with its own product icon, only that product's tools,
  and only that product's credentials, all required. The manifests are generated
  from the tool catalog by `npm run tools:sync`. The all-in-one bundle remains
  available as `npm run mcpb:pack:suite`.
- The stdio entry starts with any one product configured; it no longer insists
  on PSA, which the Automate and Control bundles do not have.
- ConnectWise Control (ScreenConnect) can be configured from the Claude Desktop
  bundle: `screenconnect_url`, `screenconnect_username` and
  `screenconnect_password` in `user_config`, mapped to `CW_SCREENCONNECT_*`.
  Before this the Control tools could only register on a shell-configured
  install.

### Fixed
- An Automate URL pasted from the browser (`https://host/automate/`) or given as
  the API path (`https://host/cwa/api/v1`) is reduced to the server root. Before
  this the token request went to `/automate/cwa/api/v1/apitoken` and failed
  with 405, which read like a credential problem. A 405 from the token endpoint
  now says the URL is wrong.
- Optional bundle settings the user never filled in are treated as unset.
  Claude Desktop passes such fields through as the literal text
  `${user_config.automate_username}`, which `loadConfig` used to accept as a
  real value: Automate then authenticated with that string as the username and
  Control tried to fetch `${user_config.screenconnect_url}/...`.

### Changed
- `manifest.json` lists tools by their Title Case title, the name Claude Desktop
  shows, and `npm run tools:sync` writes it that way.
- `npm run mcpb:pack` packs `dist/connectwise.mcpb` from a clean staging
  directory with production dependencies only.
- The stdio entry point exits with a clear message when PSA is not configured
  instead of registering no tools.
- Bundle name is `connectwise`, author DivergeIT, with a 512 px icon.

## [0.3.0] - 2026-08-25

### Changed — breaking

- **Every tool is now named `cw_*`.** `psa_*` became `cw_*`, `automate_*` became
  `cw_automate_*`, and `screenconnect_*` became `cw_control_*`. One prefix keeps
  the ConnectWise tools together in clients that aggregate several servers, and
  the wire name now maps mechanically onto the Title Case name a client displays:
  `cw_list_boards` shows as **List Boards**. Anything that called the old names —
  saved prompts, other people's skills — has to be updated.
- **The raw escape hatches are split by safety, not left to a `method` argument.**
  `cw_api_request` and `cw_automate_api_request` are GET-only and annotated
  read-only, so a host can run them without a prompt and Claude can run several at
  once. Writes moved to `cw_api_write` and `cw_automate_api_write`, which are
  annotated as destructive writes, carry
  `_meta["anthropic/requiresUserInteraction"]` so Claude Code asks a person on
  every call, and keep the `confirm: true` guards unchanged. Control keeps a
  single passthrough, because its `.ashx` services answer reads over POST.
- **Renamed the server to `connectwise-manage-mcp`** — the package name, the
  binary, the MCPB bundle identifier, the marketplace name, and the name MCP
  clients display.

### Added

- **A declared tool contract.** `src/tools/spec.ts` turns one declared kind
  (`read` or `write`) into the MCP annotations every client gates on, sends the
  display title as both `title` and `annotations.title` because clients read one
  or the other, and is the only path by which a tool can be registered. No tool
  ships unannotated — Microsoft 365 Copilot treats an unannotated tool as
  destructive, and Claude parallelizes only calls it has been told are read-only.
- **An interactive tool.** `cw_get_ticket` declares an MCP Apps (SEP-1865)
  `ui://` resource and returns `structuredContent` alongside its JSON, so hosts
  that support MCP Apps render a ticket card — status, assignment, recent notes,
  and a box that posts an internal note back through `cw_add_ticket_note` — while
  every other host gets exactly the JSON it got before. The card is declared under
  both the MCP Apps key and the ChatGPT `openai/outputTemplate` alias, and is a
  single self-contained document: no CDN, no network.
- **Generated tool documentation.** `docs/TOOLS.md`, the README tool table and the
  MCPB manifest's tool list are written from `src/tools/catalog.ts` by
  `npm run tools:sync`; `npm run tools:check` fails on drift and runs in CI.
- **MCPB bundle.** `manifest.json` describes the local stdio install for Claude
  Desktop, with every tool and the user configuration the server reads.
  `npm run mcpb:validate` and `npm run mcpb:pack` build and check it.
- **Azure Container Apps deployment.** `infra/main.bicep` (Container Apps
  environment, user-assigned managed identity, Key Vault secret references, Log
  Analytics, container registry) and a `deploy-azure.yml` workflow using OIDC
  federation with no stored credential. `docs/deploying-azure.md` is the runbook.
- **Continuous integration.** This repository had no CI. `ci.yml` runs typecheck,
  build, tests, and MCPB validation, checks that the build leaves no tracked file
  modified, and asserts that `manifest.json` lists exactly the tools the server
  registers — the drift that otherwise happens the first time someone adds a tool.
- Graceful SIGTERM/SIGINT draining on the remote entry. A severed write is worse
  than a severed read: the caller cannot tell whether the ticket was created.
- `npm run start:remote`, `npm run docker:build`.

### Security
- **The remote entry now fails closed.** With neither `MCP_AUTH_TOKEN` nor an
  Entra pair configured it previously logged a warning and served anyway. It now
  exits non-zero. This connector can create and update tickets, add notes, create
  time and expense entries, and issue raw requests to three products, so an open
  endpoint is not a degraded deployment of it.
  `MCP_ALLOW_ANONYMOUS=true` overrides the guard for a local, non-routable test
  and names the consequence in the warning it prints.

[0.3.0]: https://github.com/patrickking67/connectwise-mcp/commits/main
