# Payload result contract

Every payload, on every platform, follows the same contract so that one row
table can serve all of them.

## Output

1. The **last stdout line** is `<PREFIX>_RESULT=<CODE>`, optionally followed by
   a space and a human message on macOS. Example:
   `SCALEPAD_RESULT=OK_INSTALLED`.
2. The **bare code** (no message, no newline) is written to a result file:
   - Windows: `%ProgramData%\<Org>\<Product>\last-result.txt`
   - macOS: `/Library/Application Support/<Org>/<product>-result`, with the
     folder `chmod 700`
3. The result file is written **first** in the exit routine, before cleanup,
   so a slow or failing cleanup cannot lose it. A failed write prints a line
   saying Automate will record `NO_RESULT`.
4. Exit status: 0 for `OK_`, `SKIP_` and `WARN_`. Non-zero for `FAIL_` on
   Windows. Always 0 on macOS, so the Shell step still captures the output.

## Code taxonomy

| Prefix | Meaning | Automate exit | Monitor |
|---|---|---|---|
| `OK_` | Desired state reached or confirmed | normal | no |
| `SKIP_` | Policy says leave this device alone | normal | no |
| `WARN_` | Needs a human, but a rerun won't fix it | normal | yes, except `WARN_BUSY` |
| `FAIL_` | Something broke; a rerun might fix it | Script Exit with Error | yes |
| `NO_RESULT` | No fresh result file (set by the Automate read step) | Script Exit with Error | yes |

Standard codes worth reusing:

| Code | When |
|---|---|
| `OK_INSTALLED` / `OK_ENROLLED` / `OK_PENDING` | Installed this run / already installed and registered / installed, registration in flight |
| `SKIP_CLIENT` / `SKIP_EXCLUDED` / `SKIP_DEVICE` / `SKIP_NO_OS` | Client gate off / computer EDF exclusion / device class excluded / no OS branch ran |
| `WARN_BUSY` | Lock held by another run. **Stdout only**: touches no files, and the row table skips the EDF write. |
| `WARN_STALLED` | Installed, but registration never completed within the grace window |
| `WARN_REPORT_ONLY` | Dry-run mode and work would be needed |
| `FAIL_TOKEN` / `FAIL_TOKEN_EDF` | Secret empty, unsubstituted or malformed (payload / Automate row) |
| `FAIL_PRIVILEGE` | Not SYSTEM or root |
| `FAIL_DETECT` | Could not determine the installed state |
| `FAIL_DOWNLOAD` | Network failure, size floor, wrong file type, wrong product ID, bad signature |
| `FAIL_INSTALL` / `FAIL_VERIFY` | Installer failed / installer succeeded but nothing registered |
| `FAIL_UNHANDLED` | Top-level catch (Windows) |
| `FAIL_INTERRUPTED` | HUP, INT or TERM trap (macOS) |
| `FAIL_ARCH` | Unsupported CPU architecture |

## Freshness reads

The Automate row that reads the result file must ignore stale files:

```powershell
$f = "$env:ProgramData\<Org>\<Product>\last-result.txt"
$i = Get-Item -LiteralPath $f -ErrorAction SilentlyContinue
if ($i -and $i.Length -gt 0 -and $i.LastWriteTime -gt (Get-Date).AddMinutes(-60)) { ([IO.File]::ReadAllText($f)).Trim() } else { 'NO_RESULT' }
```

```sh
f="/Library/Application Support/<Org>/<product>-result"; if [ -s "$f" ] && [ -n "$(find "$f" -mmin -60)" ]; then cat "$f"; else printf NO_RESULT; fi
```

## Ordering inside the payload

1. Privilege check, then report `FAIL_PRIVILEGE`. This writes the result file,
   which is acceptable because nothing else can be running as this user.
2. **Take the lock.** If it is held, print `WARN_BUSY` and exit. Touch nothing.
3. Delete the previous result file. It belongs to this run now.
4. Install the signal trap (macOS) or enter the top-level try (Windows).
5. Validate the secret: empty, unsubstituted sentinel, format regex. Log a
   short hash fingerprint, never the value.
6. Device-class gate.
7. Detect the installed state. Throwing means `FAIL_DETECT`; empty means not
   installed.
8. Download into a private work folder. Check the size floor, file magic, and
   product identity (MSI UpgradeCode, or pkg signature status and team ID).
9. Install, verify the receipt or registration, report.

## Secrets

- macOS: never put secrets in argv. Use a `chmod 600` file the installer
  reads.
- Windows: an MSI property sits on msiexec's command line, which only
  administrators can see. Pair it with `MsiHiddenProperties`, and never use
  `/L*v`.
- On failure, keep the installer log only after replacing the secret with its
  fingerprint. If the redaction fails, delete the log.
- Roll back a written token file when the installer fails.
