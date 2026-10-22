---
name: automate-script-review
description: This skill should be used when the user asks to "review this Automate script", "lint my Automate payload", "check this PowerShell for Automate", "is this Automate script safe", "harden this deployment script", or runs /automate-script-review with a payload file. Lints ConnectWise Automate PowerShell and sh payloads for variable-substitution injection, missing result markers, encoding problems and platform pitfalls, then gives a ship / fix verdict.
argument-hint: "<payload file> [more files] [--marker PREFIX_RESULT=]"
allowed-tools: ["Read", "Grep", "Glob", "Bash"]
version: 0.1.0
---

# Automate Script Review

Review one or more Automate payloads named in `$ARGUMENTS`. If no file is
given, grep `*.ps1` and `*.sh` in the working directory for
`@[A-Za-z_][A-Za-z0-9_]*@`, and confirm the list with the user.

This skill only reads local files and runs the linter. It never calls
Automate tools and never pastes or pushes a payload into Automate.

## Steps

1. **Run the linter** on every file:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/skills/automate-script-review/scripts/lint-automate-payload.sh" --marker <PREFIX>_RESULT= <files>
   ```

   If `CLAUDE_PLUGIN_ROOT` is unset, find the script with Glob
   `**/lint-automate-payload.sh`. Pass the literal result prefix (for example
   `SCALEPAD_RESULT=`) only if the payload prints it literally. If the payload
   builds the prefix from a variable, keep the default `_RESULT=`. The rule
   only checks that the marker appears in code, not on every exit path. Output is tab-separated:
   `LEVEL  file:line  rule  message`. It exits 1 if there is any ERROR. When
   `shellcheck` and `pwsh` with PSScriptAnalyzer are installed, their findings
   are folded in.

2. **Confirm each ERROR and WARN** by reading the flagged line. Drop false
   positives and say why. Skim the INFO `substitution` lines as an inventory
   of every place Automate will paste text in. Check by hand any multi-line
   PowerShell `@" ... "@` here-string or unquoted sh `<<EOF` heredoc that
   contains an `@var@`. Both expand `$( )`, and the line-based rules can miss
   them.

3. **For a deeper pass**, or when a row table is involved, dispatch the
   `automate-script-reviewer` agent. It checks lock ordering, result-file
   timing, detection failures, download identity and row-table logic, which
   static rules can't see.

4. **Report** a verdict (`ship`, `ship after fixes`, `do not ship`) and the
   confirmed findings, most severe first, each with `file:line` and the exact
   fix. `do not ship` means any confirmed ERROR, or any injection or
   secret-exposure finding. `ship after fixes` means confirmed WARNs only.
   `ship` means INFO only. Do not edit the files unless the user asks.

## Rules the linter enforces

| Rule | Level | Why it matters |
|---|---|---|
| `token-double-quoted` | ERROR | Automate pastes `@var@` values in raw, so `$( )` inside double quotes runs as SYSTEM or root |
| `result-marker` | ERROR | Without a `PREFIX_RESULT=` line, Automate can't tell outcomes apart |
| `size` | ERROR over 32,767 chars, WARN over 30,000 | File Write Text's Data field holds at most 32,767 characters; anything longer is cut off silently |
| `non-ascii`, `bom`, `crlf` | WARN | The editor and agent mangle these; CRLF breaks `/bin/sh` |
| `start-process-wait` | WARN | PS 5.1 also waits on descendant processes and can hang on msiexec |
| `iwr-basic-parsing` | WARN | Without `-UseBasicParsing`, PowerShell needs the IE engine, which SYSTEM may lack |
| `msi-verbose-log` | WARN | `/L*v` writes secrets to the log |
| `predictable-temp` | WARN | A fixed MSI or EXE path in shared temp lets a user swap the file |
| `plutil-raw` | WARN | Needs macOS 12+; returns nothing on 11 |
| `uname-arch` | WARN | Reports x86_64 on Apple Silicon under Rosetta |
| `curl-no-fail` | WARN | Saves HTTP error pages as the download |
| `bashism`, `no-trap`, `silent-catch`, `progress-preference` | INFO | Portability and robustness hints |

Comments are ignored for the pattern rules: `#` lines, and `<# #>` blocks in
PowerShell. The `substitution` inventory still lists comment lines, because
Automate substitutes inside comments too.

## Related

- `automate-script-authoring` skill: templates and contract to fix findings against
- `automate-script-reviewer` agent: the full read-only review
