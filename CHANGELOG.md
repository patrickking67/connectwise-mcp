# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
