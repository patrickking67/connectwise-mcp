// Board queue: the open tickets on one service board, counted by status and
// priority, in a filterable table; a row opens the ticket card inline.
import { z } from "zod";
import type { PsaClient } from "../../lib/psa-client.js";
import { viewSpec, type ViewDefinition } from "../shell.js";
import { TICKET_PANEL_JS } from "./ticket.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const nameOf = (v: unknown): string | undefined => {
  const r = rec(v);
  return (r.name ?? r.identifier) as string | undefined;
};

function escapeCondition(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export const BOARD_VIEW: ViewDefinition<
  {
    board: z.ZodUnion<[z.ZodNumber, z.ZodString]>;
    includeClosed: z.ZodOptional<z.ZodBoolean>;
    conditions: z.ZodOptional<z.ZodString>;
    pageSize: z.ZodOptional<z.ZodNumber>;
  },
  PsaClient
> = {
  spec: viewSpec({
    name: "cw_view_board",
    summary: "Interactive queue of one service board: tickets by status and priority, filterable, each opening as a card",
    surface: "psa",
    invoking: "Loading the board…",
    invoked: "Board loaded.",
  }),
  description:
    "Interactive view of one service board's queue: open tickets counted by status and priority, in a sortable, filterable table; clicking a row opens the ticket card (notes and an internal-note box) inline. Read-only; adding a note goes through cw_add_ticket_note. Hosts without MCP Apps get the same data as JSON.",
  inputSchema: {
    board: z.union([z.number().int(), z.string()]).describe('Board id (number) or name (string), e.g. 1 or "Help Desk"'),
    includeClosed: z.boolean().optional().describe("Include closed tickets (default false)"),
    conditions: z.string().optional().describe('Extra PSA conditions ANDed in, e.g. owner/identifier="pking"'),
    pageSize: z.number().int().min(1).max(1000).optional().describe("Tickets to load (default 200)"),
  },
  page: {
    script: `${TICKET_PANEL_JS}
boot((root, view) => {
  const d = view.data;
  const tickets = d.tickets ?? [];
  const counts = (key) => { const m = {}; tickets.forEach((t) => { const k = t[key] || '—'; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  root.innerHTML = '<h1>' + esc(d.board.name ?? d.board.id) + ' <span class="badge accent">' + tickets.length + (d.hasMore ? '+' : '') + ' tickets</span>'
    + counts('priority').slice(0, 4).map(([k, n]) => '<span class="badge ' + priorityClass(k) + '">' + n + ' ' + esc(k) + '</span>').join('') + '</h1>'
    + '<div class="grid">' + counts('status').map(([k, n]) => '<div class="card"><div class="title"><span>' + esc(k) + '</span></div><div class="big">' + n + '</div><div class="bar"><span style="width:' + Math.round(100 * n / Math.max(1, tickets.length)) + '%"></span></div></div>').join('') + '</div>'
    + '<h2>Tickets</h2><div id="t"></div><div id="panel"></div>';
  const panel = $('#panel');
  table($('#t'), tickets, [
    { key: 'id', label: '#', render: (v) => '<span class="mono">' + esc(v) + '</span>' },
    { key: 'summary', label: 'Summary', wrap: true },
    { key: 'status', label: 'Status', render: (v) => '<span class="badge">' + esc(v ?? '—') + '</span>' },
    { key: 'priority', label: 'Priority', render: (v) => '<span class="badge ' + priorityClass(v) + '">' + esc(v ?? '—') + '</span>' },
    { key: 'company', label: 'Company' },
    { key: 'owner', label: 'Owner' },
    { key: 'type', label: 'Type' },
    { key: 'updated', label: 'Updated', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.updated ?? 0).getTime() },
    { key: 'entered', label: 'Age', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.entered ?? 0).getTime() },
  ], {
    sortKey: 'updated', asc: false,
    filters: [{ key: 'status', label: 'statuses' }, { key: 'priority', label: 'priorities' }, { key: 'owner', label: 'owners' }],
    empty: 'No tickets on this board.',
    onRow: async (t) => {
      panel.className = 'panel'; panel.innerHTML = '<div class="empty">Opening #' + esc(t.id) + '…</div>';
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      try { const data = await view.call('cw_get_ticket', { id: t.id }); ticketPanel(panel, view, data, { onClose: () => { panel.className = ''; panel.innerHTML = ''; } }); }
      catch (e) { panel.innerHTML = '<div class="error">' + esc(e.message) + '</div>'; }
    },
  });
});`,
  },
  load: async ({ board, includeClosed, conditions, pageSize }, client) => {
    let boardRec: Rec;
    if (typeof board === "number") {
      boardRec = rec(await client.get(`/service/boards/${board}`, { fields: "id,name" }));
    } else {
      const found = await client.getList("/service/boards", {
        conditions: `name="${escapeCondition(board)}"`,
        fields: "id,name",
        pageSize: 1,
      });
      if (found.items.length === 0) throw new Error(`Board not found: ${board}`);
      boardRec = rec(found.items[0]);
    }
    const parts = [`board/id=${boardRec.id}`];
    if (!includeClosed) parts.push("closedFlag=false");
    if (conditions) parts.push(`(${conditions})`);
    const list = await client.getList("/service/tickets", {
      conditions: parts.join(" and "),
      orderBy: "_info/lastUpdated desc",
      fields:
        "id,summary,status/name,priority/name,company/name,contact/name,owner/identifier,type/name,dateEntered,closedFlag,_info/lastUpdated",
      pageSize: pageSize ?? 200,
    });
    const tickets = list.items.map((t) => {
      const r = rec(t);
      return {
        id: r.id,
        summary: r.summary,
        status: nameOf(r.status),
        priority: nameOf(r.priority),
        company: nameOf(r.company),
        contact: nameOf(r.contact),
        owner: nameOf(r.owner),
        type: nameOf(r.type),
        entered: r.dateEntered,
        updated: rec(r._info).lastUpdated,
        closed: r.closedFlag === true,
      };
    });
    const tally = (key: "status" | "priority") => {
      const m: Record<string, number> = {};
      for (const t of tickets) {
        const k = String(t[key] ?? "—");
        m[k] = (m[k] ?? 0) + 1;
      }
      return m;
    };
    return {
      board: { id: boardRec.id, name: boardRec.name },
      count: tickets.length,
      hasMore: list.hasMore,
      byStatus: tally("status"),
      byPriority: tally("priority"),
      tickets,
    };
  },
};
