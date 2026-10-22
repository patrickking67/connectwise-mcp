# Step-table patterns

Write the script as a numbered table a tech can type straight into **Edit
Script Step**: `# | OS | Function | Fields (exact)`. Separate fields with `·`.

- **OS:** `All`, `Windows` or `Mac`, from the step's OS drop-down.
- **Function:** exactly as it appears in the Function drop-down.
- **Fields:** in the order the window shows them, with values in backticks.

Every step goes in the **Then** section; the IF section stays empty. When
revising, mark added steps **(new)** rather than renumbering silently.

Function names below are checked against ConnectWise's function reference. See
`automate-functions.md` for which ones were confirmed, and which follow
standard usage but couldn't be opened without a ConnectWise sign-in.

## Conventions every table states

- A label is a **Script Note** whose Note starts with `:`, for example `:REPORT`.
- **Variable Check** jumps to the label in **Steps to Skip** when the comparison
  is true. A blank Steps to Skip jumps to the end of the script, so never leave
  it blank. Jump forward only.
- **Script Goto** may jump in either direction.
- **Variable Name** fields take names without `@`. Everywhere else, use `@name@`.
- A step whose OS doesn't match the agent is skipped. That is how OS branches
  work.

## 1. Client gate

```
| 1 | All | Script Note | Note: `:GATE` |
| 2 | All | Extra Data Field Get Value | Extra Field: `<Enable EDF>` (client) · ID: `%ClientID%` · Variable Name: `xEnabled` |
| 3 | All | Script Log Message | Message: `<Product> gate raw=[@xEnabled@] client=%ClientName%` |
| 4 | All | Variable Check | Variable Name: `xEnabled` · Compare: `=` · To: `1` · Steps to Skip: `:CHECK_EXCLUDE` |
| 5 | All | Variable Check | Variable Name: `xEnabled` · Compare: `=` · To: `True` · Steps to Skip: `:CHECK_EXCLUDE` |
| 6 | All | Variable Set | Set Type: `Constant` · Parameter: `SKIP_CLIENT` · Variable Name: `xCode` |
| 7 | All | Variable Set | Set Type: `Constant` · Parameter: `<Product> not enabled for %ClientName%` · Variable Name: `xResult` |
| 8 | All | Script Goto | Label: `:REPORT` |
```

Test both `1` and `True`. Which one a check box returns depends on the build.

## 2. Computer exclusion

```
| 9  | All | Script Note | Note: `:CHECK_EXCLUDE` |
| 10 | All | Extra Data Field Get Value | Extra Field: `<Exclude EDF>` (computer) · ID: `%ComputerID%` · Variable Name: `xExclude` |
| 11 | All | Variable Check | Variable Name: `xExclude` · Compare: `=` · To: `1` · Steps to Skip: `:EXCLUDED` |
| 12 | All | Variable Check | Variable Name: `xExclude` · Compare: `=` · To: `True` · Steps to Skip: `:EXCLUDED` |
```

## 3. Secret validation

Run this before any payload step, so a bad EDF value never reaches a shell:

```
| n   | All | Extra Data Field Get Value | Extra Field: `<Secret EDF>` (client) · ID: `%ClientID%` · Variable Name: `<secretvar>` |
| n+1 | All | Variable Check | Variable Name: `<secretvar>` · Compare: `Not Exists` · To: (blank) · Steps to Skip: `:BAD_TOKEN` |
| n+2 | All | Variable Check | Variable Name: `<secretvar>` · Compare: `=` · To: (blank) · Steps to Skip: `:BAD_TOKEN` |
| n+3 | All | Variable Check | Variable Name: `<secretvar>` · Compare: `Contains` · To: `<secretvar>` · Steps to Skip: `:BAD_TOKEN` |
| n+4 | All | Variable Check | Variable Name: `<secretvar>` · Compare: `Contains` · To: `'` · Steps to Skip: `:BAD_TOKEN` |
```

- **n+3** catches an unsubstituted literal.
- **n+4** is required whenever the payload single-quotes the variable.

## 4. OS branches

Set the `SKIP_NO_OS` default **before** the branch labels. A Linux agent skips
both branches and reports it:

```
| | All | Variable Set | Set Type: `Constant` · Parameter: `SKIP_NO_OS` · Variable Name: `xCode` |
| | All | Script Note | Note: `:WINDOWS` |
| | Windows | Execute Script | Script Type: `PowerShell Bypass` · Script to Execute: payload · Script Parameters: (blank) · Script Credentials: `Local Agent` · Variable: `xResult` |
| | Windows | Variable Check | Variable Name: `xResult` · Compare: `Contains` · To: `<PREFIX>_RESULT=WARN_BUSY` · Steps to Skip: `:BUSY` |
| | Windows | Execute Script | Script Type: `PowerShell` · Script to Execute: freshness read · Script Parameters: (blank) · Script Credentials: `Local Agent` · Variable: `xCode` |
| | Windows | Script Goto | Label: `:REPORT` |
| | All | Script Note | Note: `:MACOS` |
| | Mac | Shell | Command: mkdir + chown root:wheel + chmod 700 the staging folder |
| | Mac | File Write Text | Text File: `<staging>/x-deploy.sh` · Data: payload |
| | Mac | Shell | Command: `/bin/sh "<staging>/x-deploy.sh"; rm -f "<staging>/x-deploy.sh"` |
| | Mac | Variable Set | Set Type: `Constant` · Parameter: `%shellresult%` · Variable Name: `xResult` |
| | Mac | Variable Check | Variable Name: `xResult` · Compare: `Contains` · To: `<PREFIX>_RESULT=WARN_BUSY` · Steps to Skip: `:BUSY` |
| | Mac | Shell | Command: freshness read |
| | Mac | Variable Set | Set Type: `Constant` · Parameter: `%shellresult%` · Variable Name: `xCode` |
```

Copy `%shellresult%` into a variable straight away; the next Shell overwrites
it. **File Write Text** has a hard limit of 32,767 characters, so keep payloads
under it. The linter warns above 30,000.

## 5. Report and exits

```
| | All | Script Note | Note: `:REPORT` |
| | All | Script Log Message | Message: `<Product> @xCode@ on %ComputerName%: @xResult@` |
| | All | Extra Data Field Set Value | Extra Field: `<Status EDF>` (computer) · ID: `%ComputerID%` · Value: `@xCode@` |
| | All | SQL Get Value | SQL: `SELECT CAST(NOW() AS CHAR)` (result in `%sqlresult%`) |
| | All | Extra Data Field Set Value | Extra Field: `<Checked EDF>` (computer) · ID: `%ComputerID%` · Value: `%sqlresult%` |
| | All | Variable Check | Variable Name: `xCode` · Compare: `Contains` · To: `FAIL_` · Steps to Skip: `:FAILED` |
| | All | Variable Check | Variable Name: `xCode` · Compare: `Contains` · To: `NO_RESULT` · Steps to Skip: `:FAILED` |
| | All | Script Exit | (no fields) |
| | All | Script Note | Note: `:EXCLUDED` |
| | All | Variable Set | Set Type: `Constant` · Parameter: `SKIP_EXCLUDED` · Variable Name: `xCode` |
| | All | Script Goto | Label: `:REPORT` |
| | All | Script Note | Note: `:BAD_TOKEN` |
| | All | Variable Set | Set Type: `Constant` · Parameter: `FAIL_TOKEN_EDF` · Variable Name: `xCode` |
| | All | Script Goto | Label: `:REPORT` |
| | All | Script Note | Note: `:BUSY` |
| | All | Script Log Message | Message: `<Product> WARN_BUSY on %ComputerName%; EDF left to the running job` |
| | All | Script Exit | (no fields) |
| | All | Script Note | Note: `:FAILED` |
| | All | Script Exit with Error | (no fields) |
```

`:BUSY` deliberately skips the EDF write. The run holding the lock writes the
real result. If a busy run finished later and wrote `WARN_BUSY`, it would
overwrite that result.

## 6. Pre-save checklist (put one in every build sheet)

- Every step is in **Then**.
- Every Variable Check has a label in Steps to Skip.
- The OS column matches each step's drop-down.
- Execute Script has Script Parameters blank and Script Credentials `Local
  Agent`.
- Each label has exactly one Script Note, spelled identically wherever it is
  jumped to.

## 7. Monitor SQL

Limit the monitor to enabled clients, so turning a client off also stops its
tickets. Check the column names against the Automate database first:

```sql
SELECT c.ComputerID, c.Name, c.ClientID, d.Value AS Status
FROM computers c
JOIN extrafielddata d ON d.ID = c.ComputerID
JOIN extrafield f     ON f.ID = d.ExtraFieldID AND f.Name = '<Status EDF>'
WHERE (d.Value LIKE 'FAIL%' OR d.Value IN ('WARN_STALLED', 'NO_RESULT'))
  AND EXISTS (
    SELECT 1 FROM extrafielddata ce
    JOIN extrafield cf ON cf.ID = ce.ExtraFieldID AND cf.Name = '<Enable EDF>'
    WHERE ce.ID = c.ClientID AND ce.Value IN ('1', 'True'))
```
