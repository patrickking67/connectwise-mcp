// The ticket card: one service ticket with its recent notes and a box that
// posts an internal note back through cw_add_ticket_note. Also the shared
// panel the board view opens when a row is clicked.
import { z } from "zod";
import type { PsaClient } from "../../lib/psa-client.js";
import { viewSpec, viewUri, type ViewDefinition } from "../shell.js";

export const TICKET_CARD_URI = viewUri("cw_get_ticket");

/**
 * Browser-side: `ticketPanel(root, view, data, opts)` renders a ticket (`data.ticket`)
 * and its notes (`data.notes.items`) into `root`, with the internal-note composer.
 * `opts.onClose`, when given, adds a close button.
 */
export const TICKET_PANEL_JS = `
function noteKind(n) { if (n.resolutionFlag) return 'Resolution'; if (n.internalAnalysisFlag) return 'Internal'; if (n.detailDescriptionFlag) return 'Discussion'; return 'Note'; }
function ticketPanel(root, view, data, opts = {}) {
  const t = data.ticket ?? data ?? {};
  const notes = (data.notes && data.notes.items) || data.notes || [];
  const draw = (message, tone) => {
    root.innerHTML = (opts.onClose ? '<button class="close" type="button" aria-label="Close">×</button>' : '')
      + '<h1><span class="mono muted">#' + esc(t.id) + '</span> ' + esc(t.summary ?? '') + '</h1>'
      + '<div class="row">'
      + (named(t.status) ? '<span class="badge ' + (t.closedFlag ? 'ok' : 'accent') + '">' + esc(named(t.status)) + '</span>' : '')
      + (named(t.priority) ? '<span class="badge ' + priorityClass(named(t.priority)) + '">' + esc(named(t.priority)) + '</span>' : '')
      + (named(t.board) ? '<span class="badge">' + esc(named(t.board)) + '</span>' : '')
      + (named(t.type) ? '<span class="badge">' + esc(named(t.type)) + '</span>' : '')
      + (t.closedFlag ? '<span class="badge ok">Closed</span>' : '')
      + '</div>'
      + '<dl class="kv">'
      + [['Company', named(t.company)], ['Contact', named(t.contact)], ['Owner', named(t.owner)], ['Site', named(t.site)], ['Hours', t.actualHours == null ? '' : fmtHours(t.actualHours)], ['Entered', t.dateEntered ? fmtWhen(t.dateEntered) : ''], ['Updated', t._info && t._info.lastUpdated ? fmtAgo(t._info.lastUpdated) + ' (' + fmtWhen(t._info.lastUpdated) + ')' : '']]
        .filter((p) => p[1]).map((p) => '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>').join('')
      + '</dl>'
      + '<h2>Notes <span class="badge">' + notes.length + (data.notes && data.notes.hasMore ? '+' : '') + '</span></h2>'
      + (notes.length ? notes.slice(0, 8).map((n) => '<div class="note"><div class="head">' + esc(noteKind(n)) + ' · ' + esc(n.createdBy ?? n.member?.identifier ?? '') + ' · ' + esc(fmtWhen(n.dateCreated)) + '</div><div class="body">' + esc(n.text ?? n.notes ?? '') + '</div></div>').join('')
          + (notes.length > 8 ? '<p class="muted">' + (notes.length - 8) + ' older note(s) not shown.</p>' : '')
        : '<div class="empty">No notes on this ticket.</div>')
      + '<h2>Add internal note</h2>'
      + '<textarea placeholder="Visible to your team only — posted as an internal analysis note."></textarea>'
      + '<div class="row" style="margin-top:8px"><button class="primary" type="button">Add internal note</button><span class="status ' + (tone ?? '') + '">' + esc(message ?? '') + '</span></div>';
    if (opts.onClose) $('button.close', root).onclick = opts.onClose;
    const box = $('textarea', root); const button = $('button.primary', root); const status = $('.status', root);
    button.onclick = async () => {
      const value = box.value.trim();
      if (!value) { status.className = 'status err'; status.textContent = 'Write the note first.'; return; }
      button.disabled = true; status.className = 'status'; status.textContent = 'Adding…';
      try {
        await view.call('cw_add_ticket_note', { ticketId: t.id, text: value, noteType: 'internal', confirm: true });
        notes.unshift({ text: value, internalAnalysisFlag: true, dateCreated: new Date().toISOString(), createdBy: 'you' });
        draw('Note added.', 'ok');
      } catch (err) {
        button.disabled = false; status.className = 'status err'; status.textContent = err.message || 'Could not add the note.';
      }
    };
  };
  draw();
}`;

export const TICKET_VIEW: ViewDefinition<{ id: z.ZodNumber; includeNotes: z.ZodOptional<z.ZodBoolean> }, PsaClient> = {
  spec: viewSpec({
    name: "cw_get_ticket",
    summary: "Open one ticket as an interactive card, with its notes",
    surface: "psa",
    // The board view opens tickets through this tool.
    appAccessible: true,
    invoking: "Opening the ticket…",
    invoked: "Ticket opened.",
    pageTitle: "ConnectWise ticket",
  }),
  description:
    "Get one service ticket by id with full detail, including its notes by default. Hosts that support MCP Apps render the result as an interactive ticket card with an in-card internal note box; every other host gets the same JSON.",
  inputSchema: {
    id: z.number().int().describe("Ticket id"),
    includeNotes: z.boolean().optional().describe("Also fetch the ticket's notes (default true)"),
  },
  page: {
    script: `${TICKET_PANEL_JS}
boot((root, view) => { ticketPanel(root, view, view.data ?? {}); });`,
  },
  load: async ({ id, includeNotes }, client) => {
    const ticket = await client.get(`/service/tickets/${id}`);
    if (includeNotes === false) return { ticket };
    const notes = await client.getList(`/service/tickets/${id}/allNotes`, { pageSize: 25 });
    return { ticket, notes: { count: notes.items.length, hasMore: notes.hasMore, items: notes.items } };
  },
};
