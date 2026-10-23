---
name: automate-script-authoring
description: This skill should be used when the user asks to "write an Automate script", "build a ConnectWise Automate script", "deploy an agent with Automate", "turn this PowerShell into an Automate script", "make this work on Macs in Automate", "add an EDF check", "write a build sheet", or pastes Automate script rows (Execute Script, Shell, File Write Text, Extra Data Field Get/Set Value, Variable Check, Script Note labels). Covers the row table, the Windows and macOS payloads, variable substitution, result reporting into EDFs, and safe token handling.
version: 0.1.0
---

# ConnectWise Automate Script Authoring

Design Automate scripts as two layers: a **row table** (the Automate functions,
labels and EDF reads and writes) and a **payload** (the PowerShell or sh body
that does the work on the endpoint). Hand the user a build sheet they can type
into the Automate script editor row by row, plus payload files they paste in.

Automate scripts are built in the Control Center or Web script editor, not
through the API. This skill produces files and a build sheet. It never pushes
scripts with `cw_automate_api_write`.

## Non-negotiables

Apply these to every payload. Each one comes from a failure seen in production.

1. **Single-quote every `@variable@`.** Automate pastes the raw value into the
   script text *before* PowerShell or sh parses it. Inside double quotes, a
   `$( )` or backtick in an EDF value executes as SYSTEM or root. Add a
   Variable Check step (Variable Name `<var>` · Compare `Contains` · To `'` ·
   Steps to Skip `:BAD_TOKEN`) before the payload runs, since a single quote is the one character that breaks single quoting.
2. **Never put a placeholder literal in the payload.** A comparison such as
   `if ($t -eq '@accesskey@')` gets substituted too and always fails. Build the
   sentinel at runtime: `[char]64 + 'accesskey' + [char]64` in PowerShell,
   `"$(printf '\100')accesskey$(printf '\100')"` in sh.
3. **End every exit with one machine-readable line**, `<PREFIX>_RESULT=<CODE>`.
   Also write the bare code to a result file that Automate reads back in a
   separate row. Stdout messages contain quotes and line breaks that break
   Automate variables.
4. **Leave Script Parameters empty** on Execute Script rows. Anything there binds
   positionally to the payload's first `param()` and silently overrides the
   substituted value.
5. **Execute Script is Windows-only.** On macOS, use File Write Text to drop
   the payload into a root-only folder, a Shell step to run it and delete
   it, and a second Shell step to read the result file. This keeps secrets
   off the process command line, where any local user can read them with `ps`.
6. **Lock before touching shared state.** Use a mutex on Windows or a `mkdir`
   lock on macOS. A run that finds the lock held reports `WARN_BUSY` and
   changes nothing, including the result file.
7. **Treat a failed detection as unknown, not as absent.** If the
   installed-product query throws, report `FAIL_DETECT`. A busy Windows
   Installer must never trigger a reinstall over a working agent.
8. **Keep downloads in a private, randomly named folder.** SYSTEM must not run
   an MSI from a fixed path in `Windows\Temp`, where a standard user can plant
   or swap it.
9. **ASCII only.** Box-drawing characters, smart quotes and em dashes in
   comments get mangled by the editor and the agent.

## Workflow

1. **Gather the inputs.** Ask what the script deploys or changes, which OSes it
   covers, which EDFs gate it (client enable checkbox, computer exclusion,
   secret), and what "done" looks like on the endpoint. Read any vendor
   install script the user has. Keep the vendor's install logic and add a
   reporting wrapper around it. If the product is the ScalePad agent and the
   `scalepad-agent-deployment` skill is available, use its tested assets
   instead of starting from these templates.
2. **Define result codes first.** Use `OK_*`, `SKIP_*`, `WARN_*` and `FAIL_*`.
   Only `FAIL_*` ends with Script Exit with Error in Automate. A stalled device is a ticket, not
   a script failure. Follow the code table in `references/payload-contract.md`.
3. **Write the payloads** from `examples/payload-template.ps1` and
   `examples/payload-template.sh`. They implement the non-negotiables. The
   detection, download identity check (size floor, magic bytes, UpgradeCode
   or signature), install and verification sections are TODOs to fill in.
4. **Write the row table** following the patterns in
   `references/row-table-patterns.md`: gate, exclusion, secret checks, OS
   branches, busy short-circuit, report, failure exit. Number every row. Mark
   OS limits per row.
5. **Write the build sheet** from `examples/build-sheet-template.md`: pre-build
   checks, EDF list, row table, snippets, groups and schedules, monitor SQL,
   rollout waves, and a result-code table with an action per code.
6. **Review before handing over.** Run the `automate-script-review` skill (or
   the `automate-script-reviewer` agent) on each payload, and fix every ERROR.
7. **Test the macOS payload with stubs** when a shell is available: fake `id`,
   `pkgutil`, `curl`, `installer`, `sysctl` and `uname` on `PATH`. Rewrite the
   system paths into a sandbox and assert both the result line and the result
   file for each scenario. Run stub tests locally only, never on a managed
   endpoint. A worked 22-scenario harness ships with the ScalePad plugin, at
   `scalepad-agent-deployment/assets/tests/test-macos.sh`.

## Reading EDFs and computers live

When the Automate connector is configured, use `cw_automate_list_clients`,
`cw_automate_search_computers` and `cw_automate_get_computer` to check which
machines a script would target. Use the `automate-edf-report` skill to read
current EDF values. These are the only Automate calls this skill makes. Never
call `cw_automate_api_write` or any other `cw_*_api_write`, `cw_create_*` or
`cw_update_*` tool. Never set an EDF, schedule or run a script, or change a
group, even if the user asks. Write SQL Get Value rows and the monitor SQL for
an operator to enter in Automate. Never run them yourself.

## Additional Resources

### Reference files
- **`references/automate-functions.md`**: the script functions used here, what
  each one substitutes, OS limits, and the pitfalls of each
- **`references/payload-contract.md`**: the result contract, the code
  taxonomy, result-file paths and freshness reads, and the lock and signal rules
- **`references/row-table-patterns.md`**: gate, exclusion, secret
  validation, OS branching, busy short-circuit and report patterns, with row
  numbering conventions

### Examples
- **`examples/payload-template.ps1`**: a Windows payload skeleton with
  mutex, private work folder, `FAIL_DETECT`, a top-level catch, and the
  result file written first
- **`examples/payload-template.sh`**: a macOS payload skeleton with a
  `main()` wrapper, lock, trap, single-quoted token and strict pkg signature check
- **`examples/build-sheet-template.md`**: the build-sheet outline to fill in
