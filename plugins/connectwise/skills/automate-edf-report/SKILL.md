---
name: automate-edf-report
description: This skill should be used when the user asks "what's the deployment status at Acme", "which machines failed the ScalePad deploy", "show the Automate EDF values", "report on extra data fields", "which computers are excluded", "who still shows NO_RESULT", or runs /automate-edf-report. Reads ConnectWise Automate computer and client Extra Data Field values, read-only, and summarises a deployment script's result codes per client.
argument-hint: "[client name] [EDF name, default: ScalePad Agent Status]"
allowed-tools: ["mcp__*__cw_status_server", "mcp__*__cw_automate_list_clients", "mcp__*__cw_automate_search_computers", "mcp__*__cw_automate_get_computer", "mcp__*__cw_automate_api_get", "Read"]
version: 0.1.0
---

# Automate EDF Report

Produce a per-client rollup of a deployment script's status EDF, such as
`ScalePad Agent Status`, `ScalePad Agent Checked`, `Exclude from ScalePad` and
the client `Enable ... Deployment` checkbox. This skill reads only.

## Hard limits

- Use only `cw_status_server`, `cw_automate_list_clients`,
  `cw_automate_search_computers`, `cw_automate_get_computer` and
  `cw_automate_api_get`.
- **Never** call `cw_automate_api_write`. Do not set EDFs, run scripts or
  change groups from this skill, even if asked mid-report. Point the user to
  Automate for those, as deliberate operator actions. Also never call
  `cw_api_write`, `cw_create_*`, `cw_update_*` or `cw_add_*`. Don't open
  tickets for failed machines; list them for the user.
- Never print a secret EDF. Treat any EDF whose name contains Token, Key,
  Password or Secret, or any Password-type field, as secret. If one
  appears in a response, show only `set` or `empty`.

## Workflow

1. **Check the connector first.** Call `cw_status_server`. If Automate is not
   configured or reports an auth failure, stop and tell the user which
   setting is missing. Do not guess values.
2. **Resolve the client.** Use `cw_automate_list_clients` and match the
   name from `$ARGUMENTS`. Ask if more than one client matches.
3. **List computers.** Call `cw_automate_search_computers` with
   `Client.Id = <id>`, paging until `hasMore` is false. If the client has
   more than about 500 computers, say so and ask before reading every
   computer's EDFs.
4. **Read the EDF values.** The Automate REST paths for EDFs have **not been
   verified** against a live server from this plugin. Try them in this order,
   with GET only and every query value passed as a string, and use the first
   one that returns data:
   1. `cw_automate_get_computer`, then look for an `ExtraDataFields` or
      similar collection in the full record.
   2. `cw_automate_api_get` path `/Computers/{id}/ExtraDataFields`
   3. `cw_automate_api_get` path `/Clients/{id}/ExtraDataFields` for the
      client gate
   Probe these on the first computer only, then use the path that worked for
   the rest. Don't try paths beyond these.
   If none return EDF data, say so plainly. Suggest the monitor SQL in the
   `automate-script-authoring` skill (`references/row-table-patterns.md`,
   section 6) as the reliable server-side alternative, for an operator to run
   in Automate.
5. **Summarise.**
   - Header: client, gate value, computer count, and when the newest
     `Checked` timestamp was.
   - Table of counts per code: `OK_*`, `SKIP_*`, `WARN_*`, `FAIL_*`,
     `NO_RESULT`, and blank (never ran).
   - "Needs attention": `FAIL_*`, `WARN_STALLED` and `NO_RESULT` machines,
     with name, code, checked time, last contact, and the action from
     section 7 of `assets/build-sheet.md` in the `scalepad-agent-deployment`
     skill if it is available. Otherwise use the code taxonomy in
     `automate-script-authoring/references/payload-contract.md`.
   - `Checked` comes from `NOW()` on the Automate server, so it is server
     local time. Compare it with the server's clock, not UTC.
   - Stale: any `Checked` timestamp older than 8 days on a machine that is
     online. It points to a schedule or group problem, not a device problem.
6. **Optional cross-check.** If the ScalePad connector is available and the
   user asks, compare `OK_ENROLLED` machines against ScalePad. The
   `scalepad-saas-status` skill in the ScalePad plugin covers that side.

## Reading the codes

`OK_` and `SKIP_` codes are healthy. `WARN_BUSY` never reaches the EDF. A
blank value means the script has never run on that machine; check the
`Deploy` group's auto-join search. `NO_RESULT` means the payload left no
fresh result file, so look at that run's script log.
