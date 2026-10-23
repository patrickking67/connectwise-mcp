# Tool renames

Wire names follow the DivergeIT house convention: `<prefix>_<verb>_<noun>`, where the verb says
what kind of tool it is — a read, a write, or an interactive `view`. Four names did not, and were
changed in **0.4.0**. Nothing else moved: every other `cw_*` name is unchanged.

| Old name (≤ 0.3.1) | New name (0.4.0) | Kind | Why |
| --- | --- | --- | --- |
| `cw_system_info` | `cw_status_system` | read | `info` is not a house verb; `status` is the verb for "report the state of something" |
| `cw_api_request` | `cw_api_get` | read | The raw read passthrough is GET-only, and the name now says so — its sibling is `cw_api_write` |
| `cw_automate_api_request` | `cw_automate_api_get` | read | Same, on the Automate surface |
| `cw_control_api_request` | `cw_control_api_write` | write | Control's `.ashx` services answer reads over POST, so this tool has always been classified as a write and has always required `confirm: true` for POST. The name now matches the classification. Use it with `method: "GET"` for reads |

## New in 0.4.0

| Name | Kind | What it is |
| --- | --- | --- |
| `cw_status_server` | read | Registered whatever is configured — including nothing. Reports which products are configured and, for one that is not, exactly which environment variables and Claude Desktop **Settings → Extensions** fields are still empty |
| `cw_view_board` | interactive | One service board's queue, counted by status and priority; a row opens the ticket card inline |
| `cw_view_company` | interactive | One company: contacts, configurations, open tickets, agreements |
| `cw_view_time` | interactive | Time entries for a period (this week by default), rolled up per member |
| `cw_automate_view_computers` | interactive | Automate agents: online/offline, OS, client, last contact |
| `cw_control_view_sessions` | interactive | Control sessions: machine, user, OS, connected or not |

## Removed in 0.5.0

ConnectWise Control (ScreenConnect) support was removed: `cw_control_list_sessions`,
`cw_control_api_write`, `cw_control_view_sessions` and the `CW_SCREENCONNECT_*` settings no longer
exist, and the `connectwise-control` bundle is no longer built.

## New in 0.5.0

| Name | Kind | What it is |
| --- | --- | --- |
| `cw_status_gate` | read | The write gate per product: write mode, allow destructive, and the env var / Settings field that opens each |
| `cw_get_configuration`, `cw_get_contact`, `cw_get_project`, `cw_get_purchase_order` | read | One PSA record in full (project with phases, team and ticket progress; PO with line items) |
| `cw_search_catalog_items`, `cw_search_products` | read | The procurement catalog, and products sold on tickets/projects/opportunities/agreements |
| `cw_view_project`, `cw_view_schedule` | interactive | One project; the dispatch calendar |
| `cw_automate_get_computer_*` (software, services, drives, alerts, patching, hardware, monitors, script_history, command_history), `cw_automate_get_command_result`, `cw_automate_get_client`, `cw_automate_get_script` | read | One Automate machine or record in detail |
| `cw_automate_list_*` (locations, contacts, groups, scripts, script_schedules, running_scripts, alerts, monitors, commands, tickets, users, patch_history, network_devices), `cw_automate_test_connection` | read | Automate lists and a login check |
| `cw_automate_run_script`, `cw_automate_run_command`, `cw_automate_run_shell_command`, `cw_automate_update_client`, `cw_automate_update_location` | write | Gated by `CW_AUTOMATE_MODE=write` |
| `cw_automate_reboot_computer`, `cw_automate_delete_script_schedule`, `cw_automate_uninstall_software` | write (disruptive) | Also need `CW_AUTOMATE_ALLOW_DESTRUCTIVE=true` |
| `cw_automate_view_fleet`, `cw_automate_view_computer`, `cw_automate_view_client` | interactive | Fleet dashboard, one machine (with Run script / Reboot), one client |

`cw_get_ticket` keeps its name — `get` is a read verb and the card is a presentation choice — but
its `ui://` resource moved from `ui://connectwise-manage/ticket-card` to
`ui://connectwise/ticket.html`, so every view now lives under one scheme.

## If you were calling the old names

The old names are gone, not aliased: an MCP client lists the tools it can call on every
connection, so a renamed tool is picked up automatically by the model. Only hard-coded callers
(a script, a prompt that names a tool, a plugin skill) need the table above.
