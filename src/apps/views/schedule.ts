// The dispatch calendar: schedule entries in a date range (the next seven days
// by default), per day and per member, with the entries in a table. Read-only.
import { z } from "zod";
import type { PsaClient } from "../../lib/psa-client.js";
import { viewSpec, type ViewDefinition } from "../shell.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const nameOf = (v: unknown): string | undefined => {
  const r = rec(v);
  return (r.name ?? r.identifier) as string | undefined;
};

function escapeCondition(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Midnight UTC today, and the same plus `days`. */
export function scheduleWindow(now: Date, days: number): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from.getTime() + days * 86_400_000);
  return { from, to };
}

export const SCHEDULE_VIEW: ViewDefinition<
  {
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    memberIdentifier: z.ZodOptional<z.ZodString>;
    includeDone: z.ZodOptional<z.ZodBoolean>;
  },
  PsaClient
> = {
  spec: viewSpec({
    name: "cw_view_schedule",
    summary: "Interactive dispatch calendar: schedule entries per day and per member (next 7 days by default)",
    surface: "psa",
    invoking: "Loading the schedule…",
    invoked: "Schedule loaded.",
  }),
  description:
    "Interactive PSA dispatch calendar: schedule entries between from and to (default today through the next 7 days), optionally for one member, grouped per day and per member with scheduled hours, and the entries (ticket/activity, type, status) in a sortable, filterable table. Done entries are hidden unless includeDone=true. Read-only. Hosts without MCP Apps get the same data as JSON.",
  inputSchema: {
    from: z.string().optional().describe("Start, ISO-8601 (default: today 00:00 UTC)"),
    to: z.string().optional().describe("End, ISO-8601 (default: from + 7 days)"),
    memberIdentifier: z.string().optional().describe('Only this member, e.g. "pking"'),
    includeDone: z.boolean().optional().describe("Include entries marked done (default false)"),
  },
  page: {
    script: `
boot((root, view) => {
  const d = view.data;
  root.innerHTML = '<h1>Schedule <span class="badge">' + esc(d.range.from.slice(0, 10)) + ' → ' + esc(d.range.to.slice(0, 10)) + '</span><span class="badge">' + d.entries.length + ' entries</span><span class="badge accent">' + esc(fmtHours(d.totalHours)) + '</span>' + (d.truncated ? '<span class="badge warn">truncated</span>' : '') + '</h1>'
    + '<div class="grid">' + d.days.map((x) => '<div class="card"><div class="title"><span>' + esc(x.day) + '</span><span class="badge">' + x.entries + '</span></div><div class="big">' + esc(fmtHours(x.hours)) + '</div></div>').join('') + '</div>'
    + '<h2>By member</h2><div id="members"></div><h2>Entries</h2><div id="entries"></div>';
  table($('#members'), d.members, [{ key: 'member', label: 'Member' }, { key: 'entries', label: 'Entries' }, { key: 'hours', label: 'Hours', render: (v) => esc(fmtHours(v)) }], { sortKey: 'hours', asc: false, empty: 'Nobody scheduled.' });
  table($('#entries'), d.entries, [
    { key: 'start', label: 'Start', render: (v) => esc(fmtWhen(v)), sort: (r) => new Date(r.start ?? 0).getTime() },
    { key: 'member', label: 'Member' }, { key: 'name', label: 'What', wrap: true },
    { key: 'type', label: 'Type' }, { key: 'objectId', label: 'Ticket/activity', render: (v) => '<span class="mono">' + esc(v ?? '—') + '</span>' },
    { key: 'status', label: 'Status', render: (v, r) => '<span class="badge ' + (r.done ? 'ok' : '') + '">' + esc(v ?? (r.done ? 'done' : '—')) + '</span>' },
    { key: 'hours', label: 'Hours', render: (v) => esc(fmtHours(v)) },
  ], { sortKey: 'start', filters: [{ key: 'member', label: 'members' }, { key: 'type', label: 'types' }], empty: 'Nothing scheduled.' });
});`,
  },
  load: async ({ from, to, memberIdentifier, includeDone }, client) => {
    const window = scheduleWindow(new Date(), 7);
    const rangeFrom = from ? new Date(from) : window.from;
    const rangeTo = to ? new Date(to) : new Date(rangeFrom.getTime() + 7 * 86_400_000);
    if (isNaN(rangeFrom.getTime()) || isNaN(rangeTo.getTime())) throw new Error("from/to must be ISO-8601 dates");
    const parts = [`dateStart >= [${rangeFrom.toISOString()}]`, `dateStart < [${rangeTo.toISOString()}]`];
    if (memberIdentifier) parts.push(`member/identifier="${escapeCondition(memberIdentifier)}"`);
    if (!includeDone) parts.push("doneFlag=false");
    const list = await client.getList("/schedule/entries", {
      conditions: parts.join(" and "),
      orderBy: "dateStart asc",
      fields: "id,name,objectId,type/name,member/identifier,member/name,dateStart,dateEnd,doneFlag,status/name,hours",
      pageSize: 1000,
    });
    const entries = list.items.map((e) => {
      const r = rec(e);
      const start = Date.parse(String(r.dateStart ?? ""));
      const end = Date.parse(String(r.dateEnd ?? ""));
      const hours =
        typeof r.hours === "number" ? r.hours : !isNaN(start) && !isNaN(end) ? Math.max(0, (end - start) / 3_600_000) : 0;
      return {
        id: r.id,
        name: r.name,
        objectId: r.objectId,
        type: nameOf(r.type),
        member: rec(r.member).identifier ?? nameOf(r.member),
        start: r.dateStart,
        end: r.dateEnd,
        status: nameOf(r.status),
        done: r.doneFlag === true,
        hours,
      };
    });
    const days = new Map<string, { day: string; entries: number; hours: number }>();
    const members = new Map<string, { member: string; entries: number; hours: number }>();
    for (const e of entries) {
      const day = String(e.start ?? "").slice(0, 10) || "—";
      const dd = days.get(day) ?? { day, entries: 0, hours: 0 };
      dd.entries += 1;
      dd.hours += e.hours;
      days.set(day, dd);
      const key = String(e.member ?? "—");
      const m = members.get(key) ?? { member: key, entries: 0, hours: 0 };
      m.entries += 1;
      m.hours += e.hours;
      members.set(key, m);
    }
    return {
      range: { from: rangeFrom.toISOString(), to: rangeTo.toISOString() },
      truncated: list.hasMore,
      totalHours: entries.reduce((n, e) => n + e.hours, 0),
      days: [...days.values()],
      members: [...members.values()],
      entries,
    };
  },
};
