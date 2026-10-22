---
name: Remote Support (ScreenConnect)
description: Use for ConnectWise Control / ScreenConnect remote sessions — e.g. "what machines are online in Control", "find the access session for Acme's server", "list active support sessions". Lists remote-access sessions. BETA and requires the ScreenConnect module configured.
version: 0.1.0
---

# ConnectWise Control (ScreenConnect) — Remote Support

Surface remote-access sessions from a ConnectWise Control instance. **Beta:** Control has no clean public REST API — these tools drive its host-page services behind forms auth, and endpoint shapes vary by Control version. Tools exist only when the ScreenConnect module is configured on the server.

## Tools

- `cw_control_list_sessions` — host sessions by type (Access / Support / Meeting); best-effort
- `cw_control_api_write` — authenticated passthrough to the instance; the reliable surface when conveniences don't fit your version. Control answers many reads over POST, so POST is available and requires `confirm: true`

## Workflow

1. **List sessions.** `cw_control_list_sessions` with `sessionType`:
   - `Access` (default) — unattended/managed machines
   - `Support` — active attended support sessions
   - `Meeting` — meetings
2. **If that errors** (version mismatch), fall back to `cw_control_api_write`, e.g. `POST /Services/PageService.ashx/GetHostSessionInfo` — the body for `.ashx` services is a positional argument array specific to your Control version.
3. **Report** online vs. offline machines, session names, and last activity. Match a machine to a client by name/group.

## Tips

- This complements RMM: Automate tells you a machine is offline; Control tells you whether you can reach it for a remote session.
- Session group/name usually encodes the client — use it to scope to one company.

## Guardrails

- Beta and instance-dependent — if a tool returns an auth or shape error, report it plainly and suggest the passthrough; don't pretend a result exists.
- `cw_control_api_write` POSTs hit live remote-access infrastructure and require `confirm: true`. Never initiate, end, or transfer a remote session without the user explicitly asking.
