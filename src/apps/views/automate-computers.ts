// Automate computers: agents online/offline with OS and last contact, in a
// filterable table with counts.
import { z } from "zod";
import type { AutomateClient } from "../../lib/automate-client.js";
import { viewSpec, type ViewDefinition } from "../shell.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

/** Automate reports contact as a timestamp; treat the last ten minutes as online when no Status field says otherwise. */
const ONLINE_WINDOW_MS = 10 * 60_000;

export function computerOnline(r: Rec, now = Date.now()): boolean {
  const status = String(r.Status ?? "").toLowerCase();
  if (status === "online") return true;
  if (status === "offline") return false;
  const last = Date.parse(String(r.LastContactDate ?? r.RemoteAgentLastContact ?? ""));
  return !isNaN(last) && now - last < ONLINE_WINDOW_MS;
}

export const AUTOMATE_COMPUTERS_VIEW: ViewDefinition<
  {
    condition: z.ZodOptional<z.ZodString>;
    clientId: z.ZodOptional<z.ZodNumber>;
    pageSize: z.ZodOptional<z.ZodNumber>;
  },
  AutomateClient
> = {
  spec: viewSpec({
    name: "cw_automate_view_computers",
    title: "View Automate Computers",
    summary: "Interactive table of Automate agents: online or offline, OS, client and last contact",
    surface: "automate",
    invoking: "Loading Automate computers…",
    invoked: "Computers loaded.",
  }),
  description:
    "Interactive table of ConnectWise Automate agents (computers): online/offline with counts, operating system, client, location, IP and last contact, sortable and filterable. Read-only. Condition examples: ComputerName contains 'SRV', Client.Id = 5. Hosts without MCP Apps get the same data as JSON.",
  inputSchema: {
    condition: z.string().optional().describe("Automate condition expression (single quotes for strings)"),
    clientId: z.number().int().optional().describe("Only this Automate client's computers"),
    pageSize: z.number().int().min(1).max(1000).optional().describe("Computers to load (default 250)"),
  },
  page: {
    script: `
boot((root, view) => {
  const d = view.data;
  root.innerHTML = '<h1>Automate computers <span class="badge">' + d.computers.length + '</span><span class="badge ok">' + d.summary.online + ' online</span>' + (d.summary.offline ? '<span class="badge bad">' + d.summary.offline + ' offline</span>' : '') + '</h1>'
    + '<div class="grid">' + Object.entries(d.summary.byOs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => '<div class="card"><div class="title"><span>' + esc(k) + '</span></div><div class="big">' + n + '</div></div>').join('') + '</div>'
    + '<h2>Computers</h2><div id="t"></div>';
  table($('#t'), d.computers, [
    { key: 'name', label: 'Name' },
    { key: 'online', label: 'State', render: (v) => '<span class="badge ' + (v ? 'ok' : 'bad') + '">' + (v ? 'online' : 'offline') + '</span>', sort: (r) => (r.online ? 1 : 0) },
    { key: 'client', label: 'Client' },
    { key: 'location', label: 'Location' },
    { key: 'os', label: 'OS', wrap: true },
    { key: 'ip', label: 'IP', render: (v) => '<span class="mono">' + esc(v ?? '—') + '</span>' },
    { key: 'lastContact', label: 'Last contact', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.lastContact ?? 0).getTime() },
  ], { sortKey: 'name', filters: [{ key: 'client', label: 'clients' }, { key: 'os', label: 'operating systems' }], empty: 'No computers match.' });
});`,
  },
  load: async ({ condition, clientId, pageSize }, client) => {
    const parts = [condition, clientId !== undefined ? `Client.Id = ${clientId}` : undefined].filter(Boolean);
    const items = await client.get<unknown[]>("/Computers", {
      condition: parts.length ? parts.map((p) => `(${p})`).join(" and ") : undefined,
      includefields:
        "Id,ComputerName,Client,Location,OperatingSystemName,OperatingSystemVersion,LastContactDate,RemoteAgentLastContact,LocalIPAddress,Status,Type,LastUserName",
      pagesize: pageSize ?? 250,
      page: 1,
      orderby: "ComputerName asc",
    });
    const now = Date.now();
    const computers = (Array.isArray(items) ? items : []).map((c) => {
      const r = rec(c);
      return {
        id: r.Id,
        name: r.ComputerName,
        online: computerOnline(r, now),
        client: rec(r.Client).Name ?? r.ClientName,
        location: rec(r.Location).Name,
        os: r.OperatingSystemName,
        ip: r.LocalIPAddress,
        lastContact: r.LastContactDate ?? r.RemoteAgentLastContact,
        lastUser: r.LastUserName,
      };
    });
    const byOs: Record<string, number> = {};
    for (const c of computers) {
      const k = String(c.os ?? "Unknown");
      byOs[k] = (byOs[k] ?? 0) + 1;
    }
    return {
      summary: {
        total: computers.length,
        online: computers.filter((c) => c.online).length,
        offline: computers.filter((c) => !c.online).length,
        byOs,
      },
      computers,
    };
  },
};
