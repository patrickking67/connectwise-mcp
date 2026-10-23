// Company overview: the record, its contacts, configurations, open tickets
// and active agreements, each in a filterable table.
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

export const COMPANY_VIEW: ViewDefinition<{ company: z.ZodUnion<[z.ZodNumber, z.ZodString]> }, PsaClient> = {
  spec: viewSpec({
    name: "cw_view_company",
    summary: "Interactive overview of one company: contacts, configurations, open tickets and agreements",
    surface: "psa",
    invoking: "Loading the company…",
    invoked: "Company loaded.",
  }),
  description:
    "Interactive overview of one PSA company by id or identifier: the company record, active contacts, active configurations (managed assets), open service tickets and active agreements, each as a sortable, filterable table with counts in the header. Read-only. Hosts without MCP Apps get the same data as JSON.",
  inputSchema: {
    company: z.union([z.number().int(), z.string()]).describe('Company id (number) or identifier (string), e.g. 250 or "acme"'),
  },
  page: {
    script: `
boot((root, view) => {
  const d = view.data; const c = d.company ?? {};
  root.innerHTML = '<h1>' + esc(c.name ?? c.identifier) + ' <span class="badge ' + stateClass(c.status) + '">' + esc(c.status ?? '—') + '</span>'
    + '<span class="badge">' + d.contacts.length + ' contacts</span><span class="badge">' + d.configurations.length + ' configs</span>'
    + '<span class="badge ' + (d.tickets.length ? 'warn' : 'ok') + '">' + d.tickets.length + ' open tickets</span><span class="badge">' + d.agreements.length + ' agreements</span></h1>'
    + '<div class="grid">'
    + '<div class="card"><div class="title">Company</div><dl class="kv">' + [['Identifier', c.identifier], ['Type', (c.types ?? []).join(', ')], ['Phone', c.phone], ['Website', c.website], ['Address', [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ')], ['Territory', c.territory], ['Default contact', c.defaultContact]].filter((p) => p[1]).map((p) => '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>').join('') + '</dl></div>'
    + '<div class="card"><div class="title">Configurations by type</div>' + (Object.entries(d.configurationsByType).sort((a, b) => b[1] - a[1]).map(([k, n]) => '<div class="row" style="justify-content:space-between"><span>' + esc(k) + '</span><span class="badge">' + n + '</span></div>').join('') || '<div class="muted">None</div>') + '</div>'
    + '<div class="card"><div class="title">Open tickets by status</div>' + (Object.entries(d.ticketsByStatus).sort((a, b) => b[1] - a[1]).map(([k, n]) => '<div class="row" style="justify-content:space-between"><span>' + esc(k) + '</span><span class="badge">' + n + '</span></div>').join('') || '<div class="muted">None</div>') + '</div>'
    + '</div>'
    + '<h2>Open tickets</h2><div id="tickets"></div><h2>Contacts</h2><div id="contacts"></div><h2>Configurations</h2><div id="configs"></div><h2>Agreements</h2><div id="agreements"></div>';
  table($('#tickets'), d.tickets, [
    { key: 'id', label: '#', render: (v) => '<span class="mono">' + esc(v) + '</span>' },
    { key: 'summary', label: 'Summary', wrap: true },
    { key: 'status', label: 'Status', render: (v) => '<span class="badge">' + esc(v ?? '—') + '</span>' },
    { key: 'priority', label: 'Priority', render: (v) => '<span class="badge ' + priorityClass(v) + '">' + esc(v ?? '—') + '</span>' },
    { key: 'board', label: 'Board' }, { key: 'owner', label: 'Owner' },
    { key: 'updated', label: 'Updated', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.updated ?? 0).getTime() },
  ], { sortKey: 'updated', asc: false, filters: [{ key: 'board', label: 'boards' }, { key: 'status', label: 'statuses' }], empty: 'No open tickets.' });
  table($('#contacts'), d.contacts, [
    { key: 'name', label: 'Name' }, { key: 'title', label: 'Title' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
    { key: 'primary', label: 'Primary', render: (v) => (v ? '<span class="badge ok">primary</span>' : '') },
  ], { sortKey: 'name', empty: 'No active contacts.' });
  table($('#configs'), d.configurations, [
    { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status', render: (v) => '<span class="badge ' + stateClass(v) + '">' + esc(v ?? '—') + '</span>' },
    { key: 'serial', label: 'Serial', render: (v) => '<span class="mono">' + esc(v ?? '—') + '</span>' }, { key: 'ip', label: 'IP', render: (v) => '<span class="mono">' + esc(v ?? '—') + '</span>' },
    { key: 'os', label: 'OS' }, { key: 'lastLogin', label: 'Last login' },
  ], { sortKey: 'name', filters: [{ key: 'type', label: 'types' }, { key: 'status', label: 'statuses' }], empty: 'No active configurations.' });
  table($('#agreements'), d.agreements, [
    { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status', render: (v) => '<span class="badge ' + stateClass(v) + '">' + esc(v ?? '—') + '</span>' },
    { key: 'start', label: 'Start', render: (v) => esc(v ? String(v).slice(0, 10) : '—') }, { key: 'end', label: 'End', render: (v) => esc(v ? String(v).slice(0, 10) : 'open-ended') },
  ], { sortKey: 'name', empty: 'No active agreements.' });
});`,
  },
  load: async ({ company }, client) => {
    let record: Rec;
    if (typeof company === "number") {
      record = rec(await client.get(`/company/companies/${company}`));
    } else {
      const found = await client.getList("/company/companies", {
        conditions: `identifier="${escapeCondition(company)}"`,
        pageSize: 1,
      });
      if (found.items.length === 0) throw new Error(`Company not found: ${company}`);
      record = rec(found.items[0]);
    }
    const id = record.id as number;
    const [contacts, configurations, tickets, agreements] = await Promise.all([
      client.getList("/company/contacts", {
        conditions: `company/id=${id} and inactiveFlag=false`,
        fields: "id,firstName,lastName,title,defaultPhoneNbr,communicationItems,defaultFlag",
        pageSize: 100,
      }),
      client.getList("/company/configurations", {
        conditions: `company/id=${id} and activeFlag=true`,
        fields: "id,name,type/name,status/name,serialNumber,ipAddress,osType,lastLoginName,modelNumber",
        pageSize: 200,
      }),
      client.getList("/service/tickets", {
        conditions: `company/id=${id} and closedFlag=false`,
        orderBy: "_info/lastUpdated desc",
        fields: "id,summary,status/name,priority/name,board/name,owner/identifier,_info/lastUpdated",
        pageSize: 100,
      }),
      client.getList("/finance/agreements", {
        conditions: `company/id=${id} and agreementStatus="Active"`,
        fields: "id,name,type/name,agreementStatus,startDate,endDate",
        pageSize: 100,
      }),
    ]);
    const contactRows = contacts.items.map((c) => {
      const r = rec(c);
      const items = (Array.isArray(r.communicationItems) ? r.communicationItems : []).map(rec);
      const email = items.find((i) => String(rec(i.communicationType).name ?? i.communicationType ?? "").toLowerCase() === "email" || String(i.type ?? "").toLowerCase() === "email");
      return {
        id: r.id,
        name: [r.firstName, r.lastName].filter(Boolean).join(" "),
        title: r.title,
        email: email?.value,
        phone: r.defaultPhoneNbr,
        primary: r.defaultFlag === true,
      };
    });
    const configRows = configurations.items.map((c) => {
      const r = rec(c);
      return {
        id: r.id,
        name: r.name,
        type: nameOf(r.type),
        status: nameOf(r.status),
        serial: r.serialNumber,
        ip: r.ipAddress,
        os: r.osType,
        model: r.modelNumber,
        lastLogin: r.lastLoginName,
      };
    });
    const ticketRows = tickets.items.map((t) => {
      const r = rec(t);
      return {
        id: r.id,
        summary: r.summary,
        status: nameOf(r.status),
        priority: nameOf(r.priority),
        board: nameOf(r.board),
        owner: nameOf(r.owner),
        updated: rec(r._info).lastUpdated,
      };
    });
    const tally = (rows: Array<Record<string, unknown>>, key: string) => {
      const m: Record<string, number> = {};
      for (const row of rows) {
        const k = String(row[key] ?? "—");
        m[k] = (m[k] ?? 0) + 1;
      }
      return m;
    };
    return {
      company: {
        id,
        identifier: record.identifier,
        name: record.name,
        status: nameOf(record.status),
        types: (Array.isArray(record.types) ? record.types : []).map(nameOf).filter(Boolean),
        phone: record.phoneNumber,
        website: record.website,
        address: record.addressLine1,
        city: record.city,
        state: record.state,
        zip: record.zip,
        territory: nameOf(record.territory),
        defaultContact: nameOf(record.defaultContact),
      },
      contacts: contactRows,
      configurations: configRows,
      configurationsByType: tally(configRows, "type"),
      tickets: ticketRows,
      ticketsByStatus: tally(ticketRows, "status"),
      agreements: agreements.items.map((a) => {
        const r = rec(a);
        return { id: r.id, name: r.name, type: nameOf(r.type), status: r.agreementStatus, start: r.startDate, end: r.endDate };
      }),
    };
  },
};
