// Time this week: entries in a date range rolled up per member, with the
// billable share, and the entries themselves in a table.
import { z } from "zod";
import type { PsaClient } from "../../lib/psa-client.js";
import { viewSpec, type ViewDefinition } from "../shell.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const nameOf = (v: unknown): string | undefined => {
  const r = rec(v);
  return (r.name ?? r.identifier) as string | undefined;
};

/** Monday 00:00 UTC of the week containing `now`. */
export function startOfWeek(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  return d;
}

function escapeCondition(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export const TIME_VIEW: ViewDefinition<
  {
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    memberIdentifier: z.ZodOptional<z.ZodString>;
    pageSize: z.ZodOptional<z.ZodNumber>;
  },
  PsaClient
> = {
  spec: viewSpec({
    name: "cw_view_time",
    summary: "Interactive summary of time entries for a period (this week by default), rolled up per member",
    surface: "psa",
    invoking: "Loading time entries…",
    invoked: "Time entries loaded.",
  }),
  description:
    "Interactive summary of PSA time entries in a date range — this week (Monday to now, UTC) by default — rolled up per member with total and billable hours, plus the entries in a sortable, filterable table. Read-only. Hosts without MCP Apps get the same data as JSON.",
  inputSchema: {
    from: z.string().optional().describe("Range start, UTC ISO-8601 (default: Monday of this week)"),
    to: z.string().optional().describe("Range end, UTC ISO-8601 (default: now)"),
    memberIdentifier: z.string().optional().describe("Only this member's entries"),
    pageSize: z.number().int().min(1).max(1000).optional().describe("Entries to load (default 500)"),
  },
  page: {
    script: `
boot((root, view) => {
  const d = view.data;
  root.innerHTML = '<h1>Time ' + esc(String(d.range.from).slice(0, 10)) + ' → ' + esc(String(d.range.to).slice(0, 10))
    + ' <span class="badge accent">' + esc(fmtHours(d.totals.hours)) + '</span><span class="badge ok">' + esc(fmtHours(d.totals.billableHours)) + ' billable</span><span class="badge">' + d.entries.length + (d.hasMore ? '+' : '') + ' entries</span><span class="badge">' + d.members.length + ' members</span></h1>'
    + '<div class="grid">' + d.members.map((m) => '<div class="card"><div class="title"><span>' + esc(m.member) + '</span><span class="badge">' + m.entries + '</span></div><div class="big">' + esc(fmtHours(m.hours)) + '</div><div class="meta">' + esc(fmtHours(m.billableHours)) + ' billable · ' + Math.round(100 * (m.hours ? m.billableHours / m.hours : 0)) + '%</div><div class="bar"><span style="width:' + Math.round(100 * (m.hours ? m.billableHours / m.hours : 0)) + '%"></span></div></div>').join('') + '</div>'
    + (d.members.length ? '' : '<div class="empty">No time entries in this range.</div>')
    + '<h2>Entries</h2><div id="t"></div>';
  table($('#t'), d.entries, [
    { key: 'start', label: 'Start', render: (v) => esc(fmtWhen(v)), sort: (r) => new Date(r.start ?? 0).getTime() },
    { key: 'member', label: 'Member' },
    { key: 'company', label: 'Company' },
    { key: 'chargeTo', label: 'Charged to', render: (v, r) => esc((r.chargeToType ?? '') + (r.chargeToId != null ? ' #' + r.chargeToId : '')) },
    { key: 'hours', label: 'Hours', render: (v) => esc(fmtHours(v)) },
    { key: 'billable', label: 'Billable', render: (v) => '<span class="badge ' + (v === 'Billable' ? 'ok' : '') + '">' + esc(v ?? '—') + '</span>' },
    { key: 'notes', label: 'Notes', wrap: true, render: (v) => esc(String(v ?? '').slice(0, 140)) },
  ], { sortKey: 'start', asc: false, filters: [{ key: 'member', label: 'members' }, { key: 'billable', label: 'billing' }], empty: 'No entries.' });
});`,
  },
  load: async ({ from, to, memberIdentifier, pageSize }, client) => {
    const now = new Date();
    const rangeFrom = from ? new Date(from) : startOfWeek(now);
    const rangeTo = to ? new Date(to) : now;
    if (isNaN(rangeFrom.getTime()) || isNaN(rangeTo.getTime())) throw new Error("from/to must be ISO-8601 dates");
    const parts = [`timeStart >= [${rangeFrom.toISOString()}]`, `timeStart <= [${rangeTo.toISOString()}]`];
    if (memberIdentifier) parts.push(`member/identifier="${escapeCondition(memberIdentifier)}"`);
    const list = await client.getList("/time/entries", {
      conditions: parts.join(" and "),
      orderBy: "timeStart desc",
      fields:
        "id,company/name,member/identifier,member/name,chargeToType,chargeToId,timeStart,timeEnd,actualHours,billableOption,notes,workType/name",
      pageSize: pageSize ?? 500,
    });
    const entries = list.items.map((e) => {
      const r = rec(e);
      return {
        id: r.id,
        member: nameOf(r.member) ?? rec(r.member).name,
        company: nameOf(r.company),
        chargeToType: r.chargeToType,
        chargeToId: r.chargeToId,
        start: r.timeStart,
        end: r.timeEnd,
        hours: typeof r.actualHours === "number" ? r.actualHours : Number(r.actualHours ?? 0),
        billable: r.billableOption,
        workType: nameOf(r.workType),
        notes: r.notes,
      };
    });
    const byMember = new Map<string, { member: string; entries: number; hours: number; billableHours: number }>();
    for (const e of entries) {
      const key = String(e.member ?? "—");
      const m = byMember.get(key) ?? { member: key, entries: 0, hours: 0, billableHours: 0 };
      m.entries += 1;
      m.hours += e.hours;
      if (e.billable === "Billable") m.billableHours += e.hours;
      byMember.set(key, m);
    }
    const members = [...byMember.values()].sort((a, b) => b.hours - a.hours);
    return {
      range: { from: rangeFrom.toISOString(), to: rangeTo.toISOString() },
      totals: {
        entries: entries.length,
        hours: entries.reduce((s, e) => s + e.hours, 0),
        billableHours: entries.filter((e) => e.billable === "Billable").reduce((s, e) => s + e.hours, 0),
      },
      hasMore: list.hasMore,
      members,
      entries,
    };
  },
};
