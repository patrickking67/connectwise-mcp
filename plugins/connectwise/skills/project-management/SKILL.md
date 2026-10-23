---
name: Project Management
description: Use when working with ConnectWise projects — e.g. "how's the Acme migration project tracking", "show open project tickets on the rollout", "which projects are over budget", "what's due this week on project X". Reviews project status, phases, tickets, and budget-vs-actual.
version: 0.1.0
---

# ConnectWise Project Management

Give a project manager a clear read on where projects stand: status, work remaining, and budget health.

## Tools

- `cw_search_projects` — projects by status, manager, company, dates
- `cw_search_project_tickets` — work items within projects (phases, owners, status)
- `cw_search_time_entries` — actuals logged against project work
- `cw_api_get` — phases (`/project/projects/{id}/phases`), team members, and anything else under `/project/*`

## Workflow

1. **Find the project.** `cw_search_projects`:
   - Active: `closedFlag=false` (optionally `status/name="Open"`)
   - A client's: `company/identifier="acme" and closedFlag=false`
   - A PM's book: `manager/identifier="pking" and closedFlag=false`
2. **Status read.** For each project surface: status, % via budget vs. actual hours (`actualHours` vs `budgetHours`), estimated end, and open ticket count. Flag over-budget (`actualHours > budgetHours`) and past-due (`estimatedEnd < today`).
3. **Drill into work.** `cw_search_project_tickets` with `project/id=<id> and closedFlag=false`, grouped by phase. Show owners and what's in flight vs. not started.
4. **Phases / team** when asked: `cw_api_get` on `/project/projects/{id}/phases` and `/project/projects/{id}/teamMembers`.

## Tips

- Budget health = `actualHours` vs `budgetHours`; call out projects past ~80% with open work.
- For "what's due this week," filter project tickets by `requiredDate` within the window.
- Compact fields suffice for status; pull detail per ticket only when needed.

## Guardrails

Read-first. Confirm before changing project/ticket status or reassigning, and never close project items unless explicitly asked.
