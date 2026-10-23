# ConnectWise Manage MCP Server

`connectwise-manage-mcp` — run **ConnectWise PSA (Manage)** from Claude, ChatGPT, Microsoft 365 Copilot, or any other MCP client, locally or as a **remote MCP connector**. ConnectWise **Automate** (RMM) registers itself alongside it when you configure it.

- **Every tool is `cw_*`** on the wire and Title Case in the UI: `cw_list_boards` shows as **List Boards**.
- **Three kinds of tool, declared, not implied:** read-only, write, and interactive. Hosts that gate on MCP annotations (Claude, Microsoft 365 Copilot, ChatGPT) get an honest answer for every single tool.
- **One code path, every surface:** local stdio, remote Streamable HTTP, and an MCPB bundle serve the same catalog.

> **This connector writes — behind a gate.** It can create and update tickets, add notes, create time and expense entries, run Automate scripts and agent commands, and reboot machines, and it carries guarded raw-request tools for both products. Every product starts read-only: write tools stay listed but refuse until `CW_PSA_MODE=write` / `CW_AUTOMATE_MODE=write`; the disruptive tier also needs `CW_*_ALLOW_DESTRUCTIVE=true`; every write call needs `confirm: true`; `cw_status_gate` explains a refusal. The remote entry **refuses to start** unless `MCP_AUTH_TOKEN` or the Entra pair is configured — an open endpoint is not a degraded deployment of it. `MCP_ALLOW_ANONYMOUS=true` overrides the guard for a local, non-routable test and says so loudly on every start.

**Guides:** [docs/mcp-clients.md](docs/mcp-clients.md) — install it in Claude Desktop, Claude Code, claude.ai/mobile, ChatGPT/Codex, Cursor and VS Code · [docs/TOOLS.md](docs/TOOLS.md) — the full tool catalog · [docs/deploying-azure.md](docs/deploying-azure.md) — the Azure runbook (Bicep, Key Vault, OIDC deploys) · [docs/GO-LIVE.md](docs/GO-LIVE.md) — remaining steps to flip it on · [docs/SETUP.md](docs/SETUP.md) — zero-to-working walkthrough · [docs/ENTRA_SETUP.md](docs/ENTRA_SETUP.md) — per-user Microsoft Entra sign-in instead of the shared token · [docs/tool-renames.md](docs/tool-renames.md) — the 0.4.0 name changes, old → new.

## How tools are named and classified

| | Convention | Why |
| --- | --- | --- |
| Wire name | `cw_` + snake_case (`cw_search_tickets`, `cw_automate_get_computer`) | MCP identifies a tool by `name`; one prefix keeps ConnectWise tools together when a client aggregates several servers |
| Display name | Title Case, derived from the name (**Search Tickets**) | Sent as both `title` and `annotations.title`, because clients read one or the other |
| Kind | `read` · `write` · `interactive` | Read-only tools carry `readOnlyHint`; write tools declare `destructiveHint`/`idempotentHint`; interactive tools additionally declare an MCP Apps `ui://` resource |

No tool is left unannotated. Microsoft 365 Copilot treats an unannotated tool as destructive and prompts for it; Claude only parallelizes calls it has been told are read-only. Both facts are load-bearing here, so `src/tools/spec.ts` derives the annotations from a single declared kind and `registerSpecTool` is the only way a tool gets registered.

The raw write escape hatches (`cw_api_write`, `cw_automate_api_write`) also set `_meta["anthropic/requiresUserInteraction"]`, which makes Claude Code prompt a person on **every** call with no "don't ask again" — and they still require `confirm: true` on the calls that cannot be undone.

## Tools

<!-- BEGIN GENERATED TOOLS -->

86 tools: 61 read-only, 15 write, 10 interactive.

### Server

Always registered, whatever is configured — including nothing. The first thing to call when a product's tools are missing.

| Tool | Shows as | Kind | What it does |
| --- | --- | --- | --- |
| `cw_status_server` | Server Status | Read-only | Report which ConnectWise products are configured and what an unconfigured one still needs |
| `cw_status_gate` | Write Gate Status | Read-only | Report whether writes and the disruptive tier are enabled per product, and which setting opens each |

### ConnectWise PSA (Manage)

Always registered. Tickets, companies, contacts, assets, time, expenses, projects, finance, sales.

| Tool | Shows as | Kind | What it does |
| --- | --- | --- | --- |
| `cw_search_tickets` | Search Tickets | Read-only | Search service tickets |
| `cw_search_companies` | Search Companies | Read-only | Search companies (clients and vendors) |
| `cw_search_contacts` | Search Contacts | Read-only | Search contacts |
| `cw_search_configurations` | Search Configurations | Read-only | Search configurations — the managed assets tracked per company |
| `cw_search_time_entries` | Search Time Entries | Read-only | Search time entries |
| `cw_search_projects` | Search Projects | Read-only | Search projects |
| `cw_search_project_tickets` | Search Project Tickets | Read-only | Search project tickets — work items inside projects |
| `cw_search_purchase_orders` | Search Purchase Orders | Read-only | Search procurement purchase orders |
| `cw_search_catalog_items` | Search Catalog Items | Read-only | Search the procurement product catalog |
| `cw_search_products` | Search Products | Read-only | Search products sold on tickets, projects, opportunities and agreements |
| `cw_search_expenses` | Search Expenses | Read-only | Search expense entries |
| `cw_search_opportunities` | Search Opportunities | Read-only | Search sales opportunities |
| `cw_search_agreements` | Search Agreements | Read-only | Search agreements — the managed service contracts |
| `cw_search_invoices` | Search Invoices | Read-only | Search invoices |
| `cw_search_members` | Search Members | Read-only | Search members — the internal users and technicians |
| `cw_search_activities` | Search Activities | Read-only | Search sales activities — calls, meetings and tasks |
| `cw_search_schedule_entries` | Search Schedule Entries | Read-only | Search schedule entries — the dispatch calendar |
| `cw_status_system` | PSA System Status | Read-only | Read instance version and cloud/on-prem status — the cheap credentials check |
| `cw_get_ticket` | Get Ticket | Interactive | Open one ticket as an interactive card, with its notes |
| `cw_get_ticket_notes` | Get Ticket Notes | Read-only | Page through every note on a ticket |
| `cw_create_ticket` | Create Ticket | Write | Create a service ticket |
| `cw_update_ticket` | Update Ticket | Write | Update fields on a service ticket |
| `cw_add_ticket_note` | Add Ticket Note | Write | Add a discussion, internal or resolution note to a ticket |
| `cw_get_company` | Get Company | Read-only | Get one company by id or identifier |
| `cw_create_time_entry` | Create Time Entry | Write | Log time against a ticket, project ticket, activity or charge code |
| `cw_create_expense` | Create Expense | Write | Log an expense against a ticket, project ticket, activity or charge code |
| `cw_list_boards` | List Boards | Read-only | List service boards |
| `cw_get_board_info` | Get Board Info | Read-only | List the statuses, types and subtypes valid on one board |
| `cw_get_agreement_additions` | Get Agreement Additions | Read-only | List the billed line items on one agreement |
| `cw_get_ticket_tasks` | Get Ticket Tasks | Read-only | List the checklist tasks on a ticket |
| `cw_get_configuration` | Get Configuration | Read-only | Get one configuration (managed asset) with its questions and custom fields |
| `cw_get_contact` | Get Contact | Read-only | Get one contact with every phone and email |
| `cw_get_project` | Get Project | Read-only | Get one project with its phases, team and ticket progress |
| `cw_get_purchase_order` | Get Purchase Order | Read-only | Get one purchase order with its line items and receiving status |
| `cw_api_get` | PSA API Get | Read-only | GET any PSA endpoint that has no dedicated tool |
| `cw_api_write` | PSA API Write | Write | POST, PUT, PATCH or DELETE any PSA endpoint, guarded and confirmed on every call |
| `cw_view_board` | View Board | Interactive | Interactive queue of one service board: tickets by status and priority, filterable, each opening as a card |
| `cw_view_company` | View Company | Interactive | Interactive overview of one company: contacts, configurations, open tickets and agreements |
| `cw_view_time` | View Time | Interactive | Interactive summary of time entries for a period (this week by default), rolled up per member |
| `cw_view_project` | View Project | Interactive | Interactive project overview: budget vs actual hours, phases, team and project tickets |
| `cw_view_schedule` | View Schedule | Interactive | Interactive dispatch calendar: schedule entries per day and per member (next 7 days by default) |

### ConnectWise Automate (RMM)

Registered only when `CW_AUTOMATE_*` is configured.

| Tool | Shows as | Kind | What it does |
| --- | --- | --- | --- |
| `cw_automate_search_computers` | Search Automate Computers | Read-only | Search Automate agents (computers) by name, client, location, status or any condition |
| `cw_automate_get_computer` | Get Automate Computer | Read-only | Get one Automate agent in full detail |
| `cw_automate_get_computer_software` | Get Automate Computer Software | Read-only | List the software installed on one computer |
| `cw_automate_get_computer_services` | Get Automate Computer Services | Read-only | List the Windows services on one computer, with state and startup type |
| `cw_automate_get_computer_drives` | Get Automate Computer Drives | Read-only | List one computer's drives with size, free space and SMART status |
| `cw_automate_get_computer_alerts` | Get Automate Computer Alerts | Read-only | List the alerts raised for one computer |
| `cw_automate_get_computer_monitors` | Get Automate Computer Monitors | Read-only | List the monitors running against one computer and their state |
| `cw_automate_get_computer_script_history` | Get Automate Computer Script History | Read-only | List the scripts that ran on one computer and how they ended |
| `cw_automate_get_computer_command_history` | Get Automate Computer Command History | Read-only | List the commands sent to one computer, with output |
| `cw_automate_get_computer_patching` | Get Automate Computer Patching | Read-only | Patch compliance for one computer: stats, effective policy and missing or failed updates |
| `cw_automate_get_computer_hardware` | Get Automate Computer Hardware | Read-only | Operating system, BIOS, processors and printers of one computer |
| `cw_automate_get_command_result` | Get Automate Command Result | Read-only | Read the status and output of a queued command |
| `cw_automate_list_clients` | List Automate Clients | Read-only | List Automate clients (companies) |
| `cw_automate_get_client` | Get Automate Client | Read-only | Get one Automate client with its locations |
| `cw_automate_list_locations` | List Automate Locations | Read-only | List Automate locations (sites), optionally for one client |
| `cw_automate_list_contacts` | List Automate Contacts | Read-only | List Automate contacts, optionally for one client |
| `cw_automate_list_groups` | List Automate Groups | Read-only | List Automate computer groups |
| `cw_automate_list_scripts` | List Automate Scripts | Read-only | List Automate scripts with their folder and parameters |
| `cw_automate_get_script` | Get Automate Script | Read-only | Get one Automate script's definition and parameters |
| `cw_automate_list_script_schedules` | List Automate Script Schedules | Read-only | List scheduled scripts, server-wide or for one computer |
| `cw_automate_list_running_scripts` | List Automate Running Scripts | Read-only | List scripts running now, server-wide or on one computer |
| `cw_automate_list_alerts` | List Automate Alerts | Read-only | List alerts across the Automate server |
| `cw_automate_list_monitors` | List Automate Monitors | Read-only | List Automate monitors and their state |
| `cw_automate_list_commands` | List Automate Commands | Read-only | List the agent commands Automate can queue, with their ids |
| `cw_automate_list_tickets` | List Automate Tickets | Read-only | List Automate's own tickets |
| `cw_automate_list_users` | List Automate Users | Read-only | List Automate users (technicians) and whether each is an integrator account |
| `cw_automate_list_network_devices` | List Automate Network Devices | Read-only | List network devices the Automate probes discovered |
| `cw_automate_list_patch_history` | List Automate Patch History | Read-only | List patch install history, server-wide or for one computer |
| `cw_automate_test_connection` | Test Automate Connection | Read-only | Prove the Automate login works and report the server time and the login account's type |
| `cw_automate_api_get` | Automate API Get | Read-only | GET any Automate endpoint that has no dedicated tool |
| `cw_automate_run_script` | Run Automate Script | Write | Run an Automate script now on one or more computers |
| `cw_automate_run_command` | Run Automate Command | Write | Queue an Automate agent command on a computer (disruptive commands need the destructive gate) |
| `cw_automate_run_shell_command` | Run Automate Shell Command | Write | Run a cmd or PowerShell command on a computer through the Automate agent |
| `cw_automate_reboot_computer` | Reboot Automate Computer | Write | Reboot a computer through the Automate agent |
| `cw_automate_update_client` | Update Automate Client | Write | Update contact and address fields on an Automate client |
| `cw_automate_update_location` | Update Automate Location | Write | Update contact and address fields on an Automate location |
| `cw_automate_delete_script_schedule` | Delete Automate Script Schedule | Write | Delete a script schedule |
| `cw_automate_uninstall_software` | Uninstall Automate Computer Software | Write | Uninstall an application from a computer through the Automate agent |
| `cw_automate_api_write` | Automate API Write | Write | POST, PUT, PATCH or DELETE an Automate endpoint, acting on live RMM agents |
| `cw_automate_view_fleet` | View Automate Fleet | Interactive | Interactive fleet dashboard: online/offline, servers down, reboots pending, quiet agents, stale AV, by client |
| `cw_automate_view_computers` | View Automate Computers | Interactive | Interactive table of Automate agents: online or offline, OS, client and last contact |
| `cw_automate_view_computer` | View Automate Computer | Interactive | Interactive detail of one Automate computer with drives, patching, alerts, script history and Run script / Reboot buttons |
| `cw_automate_view_client` | View Automate Client | Interactive | Interactive overview of one Automate client: locations, computers online/offline, OS mix, reboots pending |

<!-- END GENERATED TOOLS -->

## Client support

| Client | Transport | What it does with the annotations |
| --- | --- | --- |
| **Claude Code** | stdio or Streamable HTTP | Runs read-only tools in parallel, prompts on writes, always prompts on the `*_api_write` tools ([docs](https://code.claude.com/docs/en/mcp)) |
| **Claude Desktop / claude.ai** | MCPB bundle or custom connector URL | Same annotations; renders the interactive views where MCP Apps is enabled |
| **ChatGPT / OpenAI Responses API** | Streamable HTTP | Reads `readOnlyHint` for approval filtering and `_meta["openai/outputTemplate"]` for the card ([Apps SDK](https://developers.openai.com/apps-sdk/)) |
| **Microsoft 365 Copilot / Copilot Studio** | Streamable HTTP | Confirms any tool where `readOnlyHint` is false or `destructiveHint` is true, labelling the prompt with `annotations.title` ([Microsoft Learn](https://learn.microsoft.com/microsoft-365/copilot/extensibility/plugin-confirmation-prompts)) |
| **VS Code / Visual Studio Copilot** | stdio or HTTP | Per-tool approval, remembered per session or solution ([Microsoft Learn](https://learn.microsoft.com/visualstudio/ide/mcp-servers)) |
| **MCP Inspector, Cursor, others** | either | Plain MCP: names, titles, annotations, JSON results |

## Local and remote

| | **Local** | **Remote** |
|---|---|---|
| Transport | stdio | Streamable HTTP (stateless) |
| Entry point | `dist/stdio.js` | `dist/index.js` |
| Runs | On your machine, beside the client | Azure Container Apps |
| Holds the ConnectWise credentials | Your machine | Key Vault |
| Authenticates callers | The OS user account | Shared token or Microsoft Entra ID |
| Installed as | An MCPB bundle (`npm run mcpb:pack`) | A URL in your client |
| Reaches | Claude Code, Desktop, on-device Cowork | …and remote Cowork, claude.ai, ChatGPT, Microsoft Foundry |

Stateless HTTP means any number of replicas can serve traffic. Azure Container Apps is the deploy target described in [docs/deploying-azure.md](docs/deploying-azure.md), and the image is portable to any container host.

## Prerequisites

1. **PSA API Member keys** (recommended over personal keys): PSA → System → Members → API Members → create member with an appropriate security role → API Keys tab → generate public/private key pair.
2. **Developer clientId**: register at <https://developer.connectwise.com/ClientID>. Required header on every PSA call. Treat it like a secret.
3. Your PSA site host. Cloud regions must use the `api-` prefix (`api-na.myconnectwise.net`, `api-eu...`, `api-au...`); the server auto-corrects the bare host. On-premise: your own hostname (HTTPS required).

## Configuration

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Notes |
| --- | --- | --- |
| `CW_PSA_SITE` | yes | e.g. `api-na.myconnectwise.net` |
| `CW_PSA_COMPANY_ID` | yes | your PSA login company id |
| `CW_PSA_PUBLIC_KEY` / `CW_PSA_PRIVATE_KEY` | yes | API member keys |
| `CW_PSA_CLIENT_ID` | yes | developer clientId GUID |
| `CW_PSA_VERSION` | no | pin API model version, e.g. `2026.4` |
| `MCP_AUTH_TOKEN` | strongly recommended | protects the `/mcp` endpoint; `openssl rand -hex 32` |
| `CW_AUTOMATE_URL` / `CW_AUTOMATE_USERNAME` / `CW_AUTOMATE_PASSWORD` / `CW_AUTOMATE_CLIENT_ID` | no | set all four to enable Automate tools |
| `CW_PSA_MODE` / `CW_AUTOMATE_MODE` | no | `write` (or `true`) lets that product's write tools run; default read-only |
| `CW_PSA_ALLOW_DESTRUCTIVE` / `CW_AUTOMATE_ALLOW_DESTRUCTIVE` | no | `true` also allows the disruptive tier (reboots, disruptive commands, deletes, uninstalls, raw `*_api_write`) |
| `PORT` | no | default 8080 |

## Run locally

```bash
npm install
npm run dev          # http://localhost:8080/mcp
npm test             # unit + integration tests
npm run tools:check  # generated tool docs still match the code
```

Quick check: `curl localhost:8080/healthz`, then point the MCP inspector at it:

```bash
npx @modelcontextprotocol/inspector
# Streamable HTTP -> http://localhost:8080/mcp  (Authorization: Bearer <MCP_AUTH_TOKEN>)
```

## Install locally (MCPB bundles)

Every client — Claude Desktop, Claude Code, claude.ai and mobile, ChatGPT and Codex, Cursor, VS Code — is covered step by step in **[docs/mcp-clients.md](docs/mcp-clients.md)**.

```bash
npm ci
npm run mcpb:pack     # dist/connectwise-psa.mcpb, dist/connectwise-automate.mcpb
```

One bundle per product, each with its own icon and asking only for that product's credentials: **ConnectWise PSA** (43 tools) and **ConnectWise Automate** (45) — each count includes the always-registered `cw_status_server` and `cw_status_gate`. Each bundle has optional **write mode** and **allow destructive** switches, both off by default. Install the ones you use through **Settings → Extensions → Advanced settings** in Claude for macOS or Windows. Both run the same server; the manifests under `manifests/` are generated from the tool catalog by `npm run tools:sync`, and `npm run mcpb:pack:suite` builds the all-in-one `dist/connectwise.mcpb` from the root manifest instead. Bundles are packed from a clean staging directory with production dependencies only.

For Claude Code, point at the stdio entry directly:

```bash
claude mcp add connectwise -- node /absolute/path/to/connectwise-mcp/dist/stdio.js
```

## Deploy to Azure Container Apps

The quick path below creates an app from source and is fine for a first look. For a repeatable deployment — Bicep, Key Vault-backed secrets, a managed identity, and an OIDC-federated deploy workflow — use [`infra/main.bicep`](infra/main.bicep) and follow [docs/deploying-azure.md](docs/deploying-azure.md).

```bash
RG=rg-connectwise-mcp
APP=connectwise-mcp
LOC=eastus
TOKEN=$(openssl rand -hex 32)

az group create -n $RG -l $LOC

# Build from source (ACR task) and create the app + environment in one shot
az containerapp up -n $APP -g $RG -l $LOC --ingress external --target-port 8080 --source .

# Secrets + env, scale to zero when idle
az containerapp secret set -n $APP -g $RG --secrets \
  cw-psa-company-id='YOUR_COMPANY_ID' \
  cw-psa-public-key='YOUR_PUBLIC_KEY' \
  cw-psa-private-key='YOUR_PRIVATE_KEY' \
  cw-psa-client-id='YOUR_CLIENT_GUID' \
  mcp-auth-token="$TOKEN"

az containerapp update -n $APP -g $RG \
  --min-replicas 0 --max-replicas 3 \
  --set-env-vars \
    CW_PSA_SITE=api-na.myconnectwise.net \
    CW_PSA_COMPANY_ID=secretref:cw-psa-company-id \
    CW_PSA_PUBLIC_KEY=secretref:cw-psa-public-key \
    CW_PSA_PRIVATE_KEY=secretref:cw-psa-private-key \
    CW_PSA_CLIENT_ID=secretref:cw-psa-client-id \
    MCP_AUTH_TOKEN=secretref:mcp-auth-token

az containerapp show -n $APP -g $RG --query properties.configuration.ingress.fqdn -o tsv
echo "MCP URL: https://<fqdn>/mcp   token: $TOKEN"
```

Any other container host (Railway, Fly.io, Cloud Run, a VPS) works the same way: build the Dockerfile, set the env vars, expose port 8080.

## Connect AI clients

| Client | How |
| --- | --- |
| **claude.ai custom connector** | Settings → Connectors → Add custom connector → URL `https://<host>/mcp/<MCP_AUTH_TOKEN>` (path token, since custom connectors can't send headers) |
| **Claude Code** | `claude mcp add --transport http connectwise https://<host>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"` |
| **Claude Desktop / others** | Streamable HTTP URL + `Authorization: Bearer <token>` header |
| **Local stdio** | `npm run build` then `claude mcp add connectwise -e CW_PSA_SITE=... -e CW_PSA_COMPANY_ID=... -e CW_PSA_PUBLIC_KEY=... -e CW_PSA_PRIVATE_KEY=... -e CW_PSA_CLIENT_ID=... -- node <repo>/dist/stdio.js` |

## Security notes

- ConnectWise credentials live **server-side only**; MCP clients never see them. Scope the API member's security role to what you actually want AI to do (the PSA security role matrix applies to API calls).
- The endpoint token can be sent as a Bearer header or embedded in the URL path (capability URL) for clients that can't send headers. Rotate it by updating the secret.
- **Per-user auth:** set `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` and the server validates Microsoft Entra bearer JWTs (signature/issuer/audience/expiry) and serves RFC 9728 OAuth discovery metadata — see [docs/ENTRA_SETUP.md](docs/ENTRA_SETUP.md). Works alongside or instead of the shared token.
- The write gate (`src/tools/gate.ts`, enforced in `registerSpecTool` for every write tool): per-product `CW_*_MODE=write`, `CW_*_ALLOW_DESTRUCTIVE=true` for the `destructiveHint` tier, and `confirm: true` on every write call — refusals happen before any request leaves the process. The read escape hatches (`cw_api_get`, `cw_automate_api_get`) cannot issue anything but `GET`.
- Annotations are hints, not enforcement — the guardrails above are in the handlers, where they hold regardless of what a client does with the metadata.

## Claude plugin + marketplace

This repo also ships a **Claude Code plugin** that wraps the hosted server with auto-activating MSP workflow skills (ticket triage, ticket creation, time, expenses, client overview, asset management, projects, agreements & billing, sales pipeline, procurement, dispatch, RMM and Automate scripting) and `/cw-status` + `/cw-triage` commands. The repo root is a marketplace, so installing is two lines:

```
/plugin marketplace add patrickking67/connectwise-mcp
/plugin install connectwise@connectwise-manage-mcp
```

Then set `CONNECTWISE_MCP_URL` (your `/mcp` endpoint) and `CONNECTWISE_MCP_TOKEN`. Details in [plugins/connectwise/README.md](plugins/connectwise/README.md).

## Roadmap

- **Port the rest of the fleet's repository baseline.** The other connectors carry `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CODE_OF_CONDUCT.md`, a governance policy, and a `check-repo-contract.mjs` invariant checker wired into CI. This repository has CI, a changelog, generated tool docs and `CLAUDE.md`, but not the rest.
- Callback (webhook) receiver for PSA ticket events.

## Layout

```
src/
  index.ts            HTTP entry (Express, stateless streamable HTTP, bearer/path-token auth)
  stdio.ts            local stdio entry
  server.ts           McpServer assembly + instructions
  config.ts           env parsing, PSA site normalization
  tools/spec.ts       tool naming, display titles, kinds -> annotations + _meta
  tools/catalog.ts    every tool spec, config-independent; the docs are generated from it
  tools/psa.ts        spec-driven search tools + workflow tools
  tools/automate.ts   Automate tools (conditional)
  tools/gate.ts       the per-product write gate
  apps/shell.ts       the shared MCP Apps view shell (CSS, boot, registerView)
  apps/views/*.ts     the interactive views (PSA: ticket, board, company, time, project, schedule; Automate: fleet, computers, computer, client)
  tools/status.ts     cw_status_server and cw_status_gate — registered whatever is configured
  lib/psa-client.ts   PSA REST client (auth, 429 retry w/ Retry-After, Link-header pagination)
scripts/sync-tool-docs.ts  regenerates docs/TOOLS.md, the README table and manifest.json
test/                 vitest suites (client, config, startup guards, end-to-end via InMemoryTransport)
infra/main.bicep      Azure Container Apps topology
manifest.json         MCPB bundle manifest for the local install
Dockerfile            image for the remote transport
```
