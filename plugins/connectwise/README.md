# ConnectWise plugin

Run **ConnectWise PSA (Manage)** and **Automate (RMM)** from your AI assistant, with workflow skills for the daily MSP grind. The plugin connects to the [ConnectWise Manage MCP Server](https://github.com/patrickking67/connectwise-mcp) (a remote MCP connector you host), so your ConnectWise credentials stay server-side and never reach the client. Works with any MCP-capable client.

## What you get

**15 skills** (auto-activate when relevant):

| Skill | For |
| --- | --- |
| Ticket Triage | Ranked service board; assign, re-status, note |
| Create Ticket | Open well-formed tickets on the right board |
| Log Time | Time entries with correct billable status |
| Expense Entry | Log/review expenses against work |
| Client Overview | 360° brief: company, contacts, assets, agreements, AR |
| Asset Management | Managed configurations/devices per client |
| Project Management | Project status, phases, budget-vs-actual |
| Agreements & Billing | Contracts, billed additions, invoices, AR |
| Sales Pipeline | Opportunities and activities |
| Procurement | Purchase orders and line items |
| Dispatch & Scheduling | Calendar, tech availability |
| RMM (Automate) | Managed endpoints, online/offline, detail |
| Automate Script Authoring | Build sheets and Windows/macOS payloads for Automate deployment scripts |
| Automate Script Review | `/automate-script-review <file>`: lint payloads for injection, result-contract and platform bugs |
| Automate EDF Report | `/automate-edf-report [client]`: read-only rollup of a deployment's status EDFs |

**Agent:** `automate-script-reviewer`, a read-only security and correctness review of Automate payloads and row tables.

**Commands:** `/cw-status` (connectivity + what's enabled) · `/cw-triage [board|company]` (triage the service board)

**Tools:** PSA tools named `cw_*` (tickets, companies, contacts, configurations, time, expenses, projects and phases, project tickets, opportunities, agreements + additions, invoices, members, activities, schedule, boards, the procurement catalog, products and purchase orders, ticket tasks, plus read and write escape hatches) and optional `cw_automate_*` (RMM) tools — all surfaced from the MCP server, each declaring whether it is read-only, a write, or interactive. The full catalog is in [docs/TOOLS.md](../../docs/TOOLS.md).

## Install

```
/plugin marketplace add patrickking67/connectwise-mcp
/plugin install connectwise@connectwise-manage-mcp
```

## Configure

The plugin reads two environment variables to reach your hosted MCP server:

| Variable | Value |
| --- | --- |
| `CONNECTWISE_MCP_URL` | `https://<your-host>/mcp` (the deployed endpoint) |
| `CONNECTWISE_MCP_TOKEN` | the server's `MCP_AUTH_TOKEN` |

Set them where your client reads env (your shell profile or `.claude/settings.json` `env`), then restart the client. Verify with `/cw-status`.

Which modules light up (PSA always; Automate optional) is controlled **server-side** by which credentials you set there — see the [connectwise-mcp repo](https://github.com/patrickking67/connectwise-mcp).

> Don't have the server yet? `docs/SETUP.md` in that repo deploys it to Azure Container Apps in a few commands. For per-user Microsoft sign-in instead of a shared token, see `docs/ENTRA_SETUP.md`.

## Notes

- **Read vs write:** search/get tools are read-only; create/update/run tools and the raw-API escape hatches make changes, and they refuse until the server operator turns on that product's write mode (`CW_PSA_MODE` / `CW_AUTOMATE_MODE`). The skills confirm before writing and never close tickets, log large/backdated time, run scripts or reboot machines without asking.
- **Permissions** are governed by the ConnectWise API member's security role on the server side — scope it to what you want the assistant to do.
