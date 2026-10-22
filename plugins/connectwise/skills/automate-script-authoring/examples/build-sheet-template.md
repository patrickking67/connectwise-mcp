# <Script name>: build sheet, rev <n>

<Org>, <date>. ConnectWise Automate deployment of <product> to <platforms>.

| File | What it is |
|---|---|
| `<payload>.ps1` | Windows payload. Paste into the Execute Script row. |
| `<payload>.sh` | macOS payload. Paste into the File Write Text row. |
| `tests/<harness>.sh` | Stubbed scenario tests for the macOS payload |

Both payloads end with `<PREFIX>_RESULT=<code>` and write the bare code to a
result file, which Automate copies into a computer EDF.

**What changed in rev <n>:** one table row per change, giving the change and
the failure it prevents.

## 1. Before you build: verify these things

One check per item on a pilot device. Cover anything taken from vendor docs
that could not be confirmed: secret format, whether File Write Text
substitutes on macOS, PowerShell bitness, egress hosts, and conflicting
policies (for example GPO or Intune browser-extension lists).

## 2. Extra Data Fields

| Level | Name | Type | Notes |
|---|---|---|---|
| Client | Enable <Product> Deployment | Checkbox | gate |
| Client | <Product> <Secret> | Text / Password | secret |
| Computer | <Product> Status | Text, read-only for techs | written by the script |
| Computer | <Product> Checked | Text, read-only for techs | written by the script |
| Computer | Exclude from <Product> | Checkbox | exclusion |

## 3. The Automate script

Numbered row table, following `row-table-patterns.md`, then the snippets:
(A) Windows freshness read, (B) macOS staging folder, (C) macOS run-and-remove,
(D) macOS freshness read. Explain any row that isn't obvious directly under
the table (for example why `:BUSY` skips the EDF write).

## 4. Groups and schedules

The auto-join search, a daily schedule on the group, a weekly reconcile on all
machines of enabled clients, and how clearing an exclusion takes effect.

## 5. Needs-attention monitor

The SQL, limited to enabled clients, with a note to check the column names. A
ticket per computer, with repeat suppression.

## 6. Rollout

| Wave | Who | Pass criteria |
|---|---|---|
| 0 | Internal: each OS and CPU type, one server, the oldest supported OS | ... |
| 1 | One friendly client | ... |
| 2 | Remaining clients in batches | Needs-attention under 5% after 48h |

## 7. Result codes and what to do

| Code | Meaning | Action |
|---|---|---|
| ... | ... | ... |
