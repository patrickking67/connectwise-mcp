---
name: RMM (Automate)
description: Use for ConnectWise Automate (RMM) — endpoints, patching, alerts and scripts — e.g. "what computers are offline at Acme", "find the agent named SRV-DC01", "which machines haven't checked in", "is this server patched", "how full is the C: drive", "run the disk cleanup script on PC-12". Requires the Automate module configured.
version: 0.2.0
---

# ConnectWise Automate (RMM)

Surface the managed-endpoint fleet — what's online, what's stale, what's unpatched — and act on single machines through the gated write tools. Automate tools exist only when the Automate module is configured on the server.

## Tools

Views (render as interactive cards where the host supports MCP Apps):
- `cw_automate_view_fleet` — the estate at a glance: offline servers, reboots pending, quiet agents, stale AV, per client
- `cw_automate_view_client` — one client: locations and every computer
- `cw_automate_view_computer` — one machine: drives, patching, alerts, script history, with Run script / Reboot buttons
- `cw_automate_view_computers` — filterable agent table

Reads:
- `cw_automate_search_computers` — by name, clientId, locationId, status, type, or any condition
- `cw_automate_get_computer` and `cw_automate_get_computer_{software,services,drives,alerts,patching,hardware,monitors,script_history,command_history}`
- `cw_automate_list_{clients,locations,contacts,groups,scripts,script_schedules,running_scripts,alerts,monitors,commands,tickets,users,patch_history,network_devices}`
- `cw_automate_test_connection`, `cw_automate_api_get` (anything else, GET only)

Writes (refuse unless the server runs with `CW_AUTOMATE_MODE=write`; every call needs `confirm: true`):
- `cw_automate_run_script`, `cw_automate_run_command`, `cw_automate_run_shell_command`, `cw_automate_update_client`, `cw_automate_update_location`
- Disruptive tier, also needs `CW_AUTOMATE_ALLOW_DESTRUCTIVE=true`: `cw_automate_reboot_computer`, disruptive commands via `cw_automate_run_command`, `cw_automate_delete_script_schedule`, `cw_automate_uninstall_software`, `cw_automate_api_write`
- `cw_status_gate` says which switches are on

## Workflow

1. **Overview.** `cw_automate_view_fleet` for "how is everything"; `cw_automate_view_client` for one client.
2. **Find machines.** `cw_automate_search_computers` — filters `clientId`, `status: "Offline"`, `type: "Server"`, or a condition with single-quoted strings: `ComputerName contains 'SRV'`, `RemoteAgentLastContact < '2026-06-08'`, `IsRebootNeeded = true`.
3. **Diagnose one machine.** `cw_automate_view_computer`, or the specific `get_computer_*` read (drives, patching, services with `State = 'Stopped' and Startup = 'Auto'`, alerts, script history).
4. **Act — only when the user asks.** Find the script with `cw_automate_list_scripts`, describe what it will do and on which machine, get an explicit yes, then `cw_automate_run_script`. Follow with `cw_automate_get_computer_script_history`. For agent commands, `cw_automate_get_command_result` reads the output.

## Tips

- Resolve a client name to its Automate id with `cw_automate_list_clients` first.
- Automate's REST API cannot acknowledge or clear alerts, or edit a computer record — say so rather than reaching for `cw_automate_api_write`.
- Cross-reference with PSA: an offline server often pairs with a `cw_search_tickets` lookup for related tickets.

## Guardrails

Never run a script, command or reboot the user did not ask for. If a write refuses, relay the refusal — it names the setting the operator must change — rather than retrying or using the raw passthrough.
