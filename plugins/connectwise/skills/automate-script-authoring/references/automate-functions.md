# Automate script functions used in deployment scripts

Behaviour notes for the functions a deployment script normally needs. They
come from building and running these scripts. Automate versions differ, so
re-check anything marked *verify* on a pilot machine.

## Variable substitution

| Syntax | Source | Notes |
|---|---|---|
| `@name@` | Script variables set by earlier rows (Extra Data Field Get Value, Variable Set, Execute Script Variable) | Replaced as raw text everywhere in later rows, **including inside payload bodies and comments**. No escaping is applied. |
| `%name%` | Built-ins: `%ComputerID%`, `%ClientID%`, `%ComputerName%`, `%ClientName%`, `%shellresult%`, `%sqlresult%` | `%shellresult%` holds the output of the most recent Shell step. Copy it to a named variable straight away (Variable Set), before the next Shell overwrites it. |

Consequences:
- Any `@word@` in a payload is a substitution site. A literal email address
  written as `@user@domain` gets mangled.
- A substituted value containing `'` breaks single quoting. Reject `'` with a
  Variable Check step (`Contains` `'`) before the payload runs.
- An unset variable usually stays as the literal `@name@` text, though some
  builds replace it with an empty string. Check for both: `Not Exists`, `= ''`,
  and `Contains name`.

## Step mechanics (confirmed against ConnectWise's function reference)

- Each step is added with right-click > Add in the **Then** section. The step
  window has an **OS** drop-down, a **Function** drop-down, the function's own
  fields, and **Save Step**. Steps whose OS doesn't match the agent are
  skipped.
- **Labels are Script Note steps** whose Note starts with `:`.
- **Variable Check jumps when the comparison is TRUE**, to the label in
  **Steps to Skip**. A **blank Steps to Skip jumps to the end of the script**,
  which silently skips the reporting steps. Never leave it blank.
- Variable Name fields take the bare name (`spCode`). Everywhere else, write
  `@spCode@`.

## Functions

Status column: **confirmed** means the name and fields were read from
ConnectWise's function pages. **Standard** means widely used under that name,
but the page needs a ConnectWise sign-in to open. Check it in the Function
drop-down; if it differs, type the first word to find it.

| Function (as in the drop-down) | Fields | Status | Pitfalls |
|---|---|---|---|
| **Script Note** | Note | confirmed | A Note starting with `:` is a label. Keep labels upper-case and spelled identically everywhere. |
| **Variable Check** | Variable Name · Compare · To · Steps to Skip | confirmed | Compare options: Exists, Not Exists, =, Not =, <, <=, >, >=, Contains, Not Contains, In, Not In. A `Contains` test on an empty variable can match unexpectedly, so order the checks Not Exists, then empty, then Contains. |
| **Variable Set** | Set Type (`Constant`) · Parameter · Variable Name | confirmed | Stage `@xCode@` and `@xResult@` before Script Goto `:REPORT`. Also used to copy `%shellresult%` into a named variable. |
| **Execute Script** | Script Type (PowerShell, VBScript, Batch, PowerShell Bypass) · Script to Execute · Script Parameters · Script Credentials (Local Agent, Run as Admin) · Variable | confirmed | **Windows only.** Writes a temporary .ps1, runs it and deletes it. Leave Script Parameters blank: they bind positionally to `param()`. Local Agent runs as SYSTEM. Bitness depends on the agent build, so the payload should log it. |
| **Shell** | Command | confirmed (field label standard) | Output lands in `%shellresult%`. Runs under `/bin/sh` as root on macOS. The command line is visible to `ps`, so never inline secrets. **Shell Enhanced** (Command · Delimiter · Variable List) also exists. It isn't needed here. |
| **File Write Text** | Text File · Data | confirmed | **Hard limit of 32,767 characters in Data.** Write macOS payloads into a `chmod 700` root-owned folder. Whether substitution happens here varies by build (*verify*); the payload's sentinel check catches it if it doesn't. |
| **Extra Data Field Get Value** | Extra Field · ID · Variable Name | standard | ID is `%ClientID%` for client fields and `%ComputerID%` for computer fields. Checkboxes return `1` or `True` depending on the build, so test for both. Password-type EDFs may come back decrypted or masked (*verify*). |
| **Extra Data Field Set Value** | Extra Field · ID · Value | standard | Write only short, quote-free values: the bare code, never stdout. |
| **SQL Get Value** | SQL | standard | Result in `%sqlresult%`. Use it for `SELECT CAST(NOW() AS CHAR)` timestamps. Keep it read-only. |
| **Script Goto** | Label | standard | May jump in either direction. |
| **Script Log Message** | Message | standard | Never log a secret variable. Log the gate raw value (`raw=[@spEnabled@]`) once, because it settles the `1` vs `True` question quickly. |
| **Script Exit** / **Script Exit with Error** | none | standard | Only *with Error* turns the history red. Reserve it for `FAIL_*` and `NO_RESULT`. |

## Scheduling and groups

- Use auto-join groups driven by EDF state: enabled client, not excluded, not
  already `OK_ENROLLED`. Schedule daily, with the offline action *run when it
  comes online*. Machines drop out of the group as they succeed.
- Add a weekly reconcile on all machines of enabled clients, ignoring status.
  It catches agents removed after success, and it is the only path back for
  machines whose exclusion was cleared.

## Platform notes worth repeating in payload comments

- **Windows PS 5.1:** use `Invoke-WebRequest -UseBasicParsing` and set
  `$ProgressPreference = 'SilentlyContinue'`. Add TLS 1.2 to
  `SecurityProtocol` (`-bor`, not assignment). Wait on msiexec with
  `Process.WaitForExit()`, not `Start-Process -Wait`, which also waits for
  every descendant process. Log with `/L*` plus `MsiHiddenProperties`, never
  `/L*v`, which writes every property, secrets included.
- **Windows Installer exit codes:** 0 ok, 3010 ok with reboot pending, 1641 ok
  with restart started, 1618 another install running (retry with backoff),
  1603 fatal.
- **macOS:** read installed versions with `pkgutil --pkg-info <id>`
  (`plutil -extract ... raw` needs macOS 12+). Detect Apple Silicon with
  `sysctl -n hw.optional.arm64` (`uname -m` says x86_64 under Rosetta).
  Flat pkgs start with the bytes `xar!`. `pkgutil --check-signature` exits
  non-zero for an unsigned pkg, so parse its `Status:` line instead of the
  exit code.
