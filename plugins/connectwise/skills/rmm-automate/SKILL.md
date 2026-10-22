---
name: RMM (Automate)
description: Use for ConnectWise Automate (RMM) — endpoints and monitoring — e.g. "what computers are offline at Acme", "find the agent named SRV-DC01", "which machines haven't checked in", "show clients in Automate", "what's the OS on this endpoint". Searches managed computers and RMM clients. Requires the Automate module configured.
version: 0.1.0
---

# ConnectWise Automate (RMM)

Surface the managed-endpoint fleet: what's online, what's stale, and details on specific machines. Automate tools exist only when the Automate module is configured on the server.

## Tools

- `cw_automate_search_computers` — agents/computers by name, client, OS, last-contact
- `cw_automate_get_computer` — full detail on one machine
- `cw_automate_list_clients` — Automate clients (companies)
- `cw_automate_api_get` — read the rest of the Automate API (scripts, monitors, alerts); GET only
- `cw_automate_api_write` — change something in Automate; asks the user every time and requires `confirm: true`

## Workflow

1. **Find machines.** `cw_automate_search_computers` with an Automate condition (single-quote strings):
   - At a client: `Client.Id = 5` (get the id from `cw_automate_list_clients`)
   - By name: `ComputerName contains 'SRV'`
   - Stale / offline: `LastContactDate < 2026-06-08` — hasn't checked in
2. **Report.** Per machine: name, client, OS, last-contact, IP, status. Flag offline/stale machines (old `LastContactDate`) — those need attention.
3. **Detail.** `cw_automate_get_computer` for one machine's full record (hardware, software, patch state).
4. **Deeper** via `cw_automate_api_get`: alerts (`/Computers/{id}/Alerts`), scripts (`/Scripts`), monitors (`/Monitors`).

## Tips

- Resolve a client name to its Automate `Client.Id` via `cw_automate_list_clients` before filtering computers.
- "What's down" = machines with a stale `LastContactDate`, grouped by client.
- Cross-reference with PSA: an offline server often pairs with a `cw_search_tickets` lookup for related tickets.

## Guardrails

Read-only by default: `cw_automate_api_get` cannot issue anything but GET. Changes go through `cw_automate_api_write`, which acts on live RMM agents, prompts the user on every call, and is refused without `confirm: true` — only run scripts or push changes when the user explicitly asks and confirms.
