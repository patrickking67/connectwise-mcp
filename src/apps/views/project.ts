// One PSA project: header with budget vs actual, phases with hours, team, and
// the project tickets by phase in a filterable table. Read-only.
import { z } from "zod";
import type { PsaClient } from "../../lib/psa-client.js";
import { summarizeProjectTickets } from "../../lib/project-summary.js";
import { viewSpec, type ViewDefinition } from "../shell.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const nameOf = (v: unknown): string | undefined => {
  const r = rec(v);
  return (r.name ?? r.identifier) as string | undefined;
};

export const PROJECT_VIEW: ViewDefinition<{ id: z.ZodNumber }, PsaClient> = {
  spec: viewSpec({
    name: "cw_view_project",
    summary: "Interactive project overview: budget vs actual hours, phases, team and project tickets",
    surface: "psa",
    invoking: "Loading the project…",
    invoked: "Project loaded.",
  }),
  description:
    "Interactive overview of one PSA project by id: status, manager, dates, percent complete and budget vs actual hours; every phase with scheduled/actual hours and status; the team; and the project tickets with phase, status and owner in a sortable, filterable table. Read-only. Find the id with cw_search_projects. Hosts without MCP Apps get the same data as JSON.",
  inputSchema: { id: z.number().int().describe("Project id (cw_search_projects)") },
  page: {
    script: `
boot((root, view) => {
  const d = view.data; const p = d.project; const t = d.ticketSummary;
  const over = p.budgetHours && p.actualHours > p.budgetHours;
  const pct = Math.max(0, Math.min(100, Number(p.percentComplete ?? 0)));
  root.innerHTML = '<h1>' + esc(p.name) + ' <span class="badge ' + stateClass(p.status) + '">' + esc(p.status ?? '—') + '</span>'
    + '<span class="badge">' + t.open + ' open / ' + t.total + ' tickets</span>' + (over ? '<span class="badge bad">over budget</span>' : '') + '</h1>'
    + '<div class="grid">'
    + '<div class="card"><div class="title">Project</div><dl class="kv">' + [['Company', p.company], ['Manager', p.manager], ['Board', p.board], ['Estimated', [p.estimatedStart, p.estimatedEnd].map((x) => (x ? String(x).slice(0, 10) : '?')).join(' → ')], ['Actual start', p.actualStart ? String(p.actualStart).slice(0, 10) : null], ['Billing', p.billingMethod]].filter((x) => x[1]).map((x) => '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>').join('') + '</dl></div>'
    + '<div class="card"><div class="title">Hours</div><div class="big" style="color:var(--' + (over ? 'bad' : 'fg') + ')">' + esc(fmtHours(p.actualHours)) + '</div><div class="meta">of ' + esc(fmtHours(p.budgetHours)) + ' budgeted</div></div>'
    + '<div class="card"><div class="title">Complete</div><div class="big">' + pct + '%</div><div class="bar"><span style="width:' + pct + '%"></span></div></div>'
    + '</div>'
    + '<h2>Phases</h2><div id="phases"></div><h2>Tickets</h2><div id="tickets"></div><h2>Team</h2><div id="team"></div>';
  table($('#phases'), d.phases, [
    { key: 'wbs', label: 'WBS', render: (v) => '<span class="mono">' + esc(v ?? '') + '</span>' },
    { key: 'name', label: 'Phase', wrap: true },
    { key: 'status', label: 'Status', render: (v) => '<span class="badge">' + esc(v ?? '—') + '</span>' },
    { key: 'open', label: 'Open' }, { key: 'closed', label: 'Closed' },
    { key: 'budgetHours', label: 'Budget', render: (v) => esc(fmtHours(v)) },
    { key: 'actualHours', label: 'Actual', render: (v, r) => '<span style="color:var(--' + (r.budgetHours && v > r.budgetHours ? 'bad' : 'fg') + ')">' + esc(fmtHours(v)) + '</span>' },
  ], { sortKey: 'wbs', empty: 'No phases.' });
  table($('#tickets'), d.tickets, [
    { key: 'id', label: '#', render: (v) => '<span class="mono">' + esc(v) + '</span>' },
    { key: 'summary', label: 'Summary', wrap: true }, { key: 'phase', label: 'Phase' },
    { key: 'status', label: 'Status', render: (v, r) => '<span class="badge ' + (r.closed ? 'ok' : '') + '">' + esc(v ?? '—') + '</span>' },
    { key: 'owner', label: 'Owner' },
    { key: 'actualHours', label: 'Hours', render: (v, r) => esc(fmtHours(v)) + (r.budgetHours ? ' / ' + esc(fmtHours(r.budgetHours)) : '') },
  ], { sortKey: 'id', filters: [{ key: 'phase', label: 'phases' }, { key: 'status', label: 'statuses' }, { key: 'owner', label: 'owners' }], empty: 'No project tickets.' });
  table($('#team'), d.team, [{ key: 'member', label: 'Member' }, { key: 'role', label: 'Role' }, { key: 'hours', label: 'Hours', render: (v) => esc(fmtHours(v)) }], { sortKey: 'member', empty: 'No team members.' });
});`,
  },
  load: async ({ id }, client) => {
    const [project, phases, team, tickets] = await Promise.all([
      client.get(`/project/projects/${id}`),
      client.getList(`/project/projects/${id}/phases`, { pageSize: 200 }),
      client.getList(`/project/projects/${id}/teamMembers`, { pageSize: 200 }).catch(() => undefined),
      client.getList("/project/tickets", {
        conditions: `project/id=${id}`,
        fields: "id,summary,phase/id,phase/name,status/name,owner/identifier,closedFlag,budgetHours,actualHours",
        pageSize: 1000,
      }),
    ]);
    const p = rec(project);
    const ticketRows = tickets.items.map((x) => rec(x));
    const summary = summarizeProjectTickets(ticketRows);
    const byPhase = new Map(summary.byPhase.map((b) => [b.phase, b]));
    return {
      project: {
        id: p.id,
        name: p.name,
        status: nameOf(p.status),
        company: nameOf(p.company),
        manager: nameOf(p.manager),
        board: nameOf(p.board),
        estimatedStart: p.estimatedStart,
        estimatedEnd: p.estimatedEnd,
        actualStart: p.actualStart,
        percentComplete: p.percentComplete,
        budgetHours: p.budgetHours,
        actualHours: p.actualHours,
        billingMethod: p.billingMethod,
      },
      ticketSummary: { total: summary.total, open: summary.open, closed: summary.closed },
      phases: phases.items.map((x) => {
        const ph = rec(x);
        const counts = byPhase.get(String(ph.description ?? ""));
        return {
          id: ph.id,
          wbs: ph.wbsCode,
          name: ph.description,
          status: nameOf(ph.status),
          budgetHours: ph.budgetHours,
          actualHours: ph.actualHours,
          scheduledHours: ph.scheduledHours,
          open: counts?.open ?? 0,
          closed: counts?.closed ?? 0,
        };
      }),
      tickets: ticketRows.map((r) => ({
        id: r.id,
        summary: r.summary,
        phase: nameOf(r.phase),
        status: nameOf(r.status),
        owner: nameOf(r.owner),
        closed: r.closedFlag === true,
        budgetHours: r.budgetHours,
        actualHours: r.actualHours,
      })),
      team: (team?.items ?? []).map((x) => {
        const m = rec(x);
        return { member: nameOf(m.member), role: nameOf(m.projectRole), hours: m.hours };
      }),
    };
  },
};
