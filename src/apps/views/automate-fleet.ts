// Automate fleet dashboard: the whole estate at a glance — online/offline,
// servers down, reboots pending, agents gone quiet, stale antivirus — with a
// per-client breakdown and the newest alerts. Read-only.
import { z } from "zod";
import type { AutomateClient } from "../../lib/automate-client.js";
import { viewSpec, type ViewDefinition } from "../shell.js";
import { computerOnline } from "./automate-computers.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

const DAY_MS = 86_400_000;

/** Days since an Automate timestamp; undefined when absent or the 0001-01-01 placeholder. */
export function daysSince(value: unknown, now = Date.now()): number | undefined {
  const t = Date.parse(String(value ?? ""));
  if (isNaN(t) || t < Date.UTC(1971, 0, 1)) return undefined;
  return Math.floor((now - t) / DAY_MS);
}

export const AUTOMATE_FLEET_VIEW: ViewDefinition<
  {
    staleDays: z.ZodOptional<z.ZodNumber>;
    avDays: z.ZodOptional<z.ZodNumber>;
    maxComputers: z.ZodOptional<z.ZodNumber>;
  },
  AutomateClient
> = {
  spec: viewSpec({
    name: "cw_automate_view_fleet",
    title: "View Automate Fleet",
    summary: "Interactive fleet dashboard: online/offline, servers down, reboots pending, quiet agents, stale AV, by client",
    surface: "automate",
    invoking: "Surveying the Automate fleet…",
    invoked: "Fleet loaded.",
  }),
  description:
    "Interactive ConnectWise Automate fleet dashboard: counts of online and offline agents, offline servers, machines waiting on a reboot, agents with no contact in staleDays (default 30), antivirus definitions older than avDays (default 7), a per-client table and the newest alerts. Read-only. Use it first for 'how is the estate doing'. Hosts without MCP Apps get the same data as JSON.",
  inputSchema: {
    staleDays: z.number().int().min(1).max(365).optional().describe("Days without contact before an agent counts as stale (default 30)"),
    avDays: z.number().int().min(1).max(365).optional().describe("Antivirus definitions older than this many days are flagged (default 7)"),
    maxComputers: z.number().int().min(1).max(5000).optional().describe("Computers to survey (default 2000)"),
  },
  page: {
    script: `
boot((root, view) => {
  const d = view.data; const s = d.summary;
  const tile = (label, n, cls, hint) => '<div class="card"><div class="title"><span>' + esc(label) + '</span></div><div class="big' + (cls ? ' ' : '') + '" style="color:var(--' + (cls || 'fg') + ')">' + n + '</div>' + (hint ? '<div class="meta">' + esc(hint) + '</div>' : '') + '</div>';
  root.innerHTML = '<h1>Automate fleet <span class="badge">' + s.total + ' agents</span><span class="badge ok">' + s.online + ' online</span><span class="badge ' + (s.offline ? 'bad' : 'ok') + '">' + s.offline + ' offline</span>' + (d.truncated ? '<span class="badge warn">first ' + s.total + ' only</span>' : '') + '</h1>'
    + '<div class="grid">'
    + tile('Servers offline', s.serversOffline, s.serversOffline ? 'bad' : 'ok', s.servers + ' servers')
    + tile('Reboot pending', s.rebootNeeded, s.rebootNeeded ? 'warn' : 'ok')
    + tile('No contact ' + d.thresholds.staleDays + 'd+', s.stale, s.stale ? 'warn' : 'ok')
    + tile('AV older than ' + d.thresholds.avDays + 'd', s.avStale, s.avStale ? 'warn' : 'ok')
    + tile('Maintenance mode', s.maintenance, '')
    + '</div>'
    + '<h2>Clients</h2><div id="clients"></div>'
    + '<h2>Needs attention</h2><div id="attention"></div>'
    + '<h2>Newest alerts</h2><div id="alerts"></div>';
  table($('#clients'), d.clients, [
    { key: 'name', label: 'Client' },
    { key: 'total', label: 'Agents' },
    { key: 'online', label: 'Online', render: (v) => '<span class="badge ok">' + v + '</span>' },
    { key: 'offline', label: 'Offline', render: (v) => '<span class="badge ' + (v ? 'bad' : '') + '">' + v + '</span>' },
    { key: 'serversOffline', label: 'Servers down', render: (v) => (v ? '<span class="badge bad">' + v + '</span>' : '0') },
    { key: 'rebootNeeded', label: 'Reboot', render: (v) => (v ? '<span class="badge warn">' + v + '</span>' : '0') },
  ], { sortKey: 'offline', asc: false, empty: 'No clients.', onRow: (r) => view.app?.sendMessage?.({ role: 'user', content: [{ type: 'text', text: 'Open the Automate client overview for ' + r.name + ' (client id ' + r.id + ') with cw_automate_view_client.' }] }) });
  table($('#attention'), d.attention, [
    { key: 'name', label: 'Computer' },
    { key: 'client', label: 'Client' },
    { key: 'type', label: 'Type' },
    { key: 'reasons', label: 'Why', wrap: true, render: (v) => v.map((x) => '<span class="badge warn">' + esc(x) + '</span>').join(' ') },
    { key: 'lastContact', label: 'Last contact', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.lastContact ?? 0).getTime() },
  ], { sortKey: 'client', filters: [{ key: 'client', label: 'clients' }, { key: 'type', label: 'types' }], empty: 'Nothing needs attention.', onRow: (r) => view.app?.sendMessage?.({ role: 'user', content: [{ type: 'text', text: 'Open Automate computer ' + r.name + ' (id ' + r.id + ') with cw_automate_view_computer.' }] }) });
  table($('#alerts'), d.alerts, [
    { key: 'date', label: 'When', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.date ?? 0).getTime() },
    { key: 'severity', label: 'Severity', render: (v) => '<span class="badge ' + stateClass(v) + '">' + esc(v ?? '—') + '</span>' },
    { key: 'source', label: 'Source' },
    { key: 'message', label: 'Message', wrap: true },
  ], { sortKey: 'date', asc: false, empty: 'No alerts.' });
});`,
  },
  load: async ({ staleDays, avDays, maxComputers }, client) => {
    const stale = staleDays ?? 30;
    const av = avDays ?? 7;
    const max = maxComputers ?? 2000;
    const fields =
      "Id,ComputerName,Client,Location,Type,Status,RemoteAgentLastContact,IsRebootNeeded,IsMaintenanceModeEnabled,AntivirusDefinitionDate,OperatingSystemName";
    const raw: unknown[] = [];
    for (let page = 1; raw.length < max; page += 1) {
      const pageSize = Math.min(1000, max - raw.length);
      const batch = await client.list("/Computers", { includeFields: fields, orderBy: "Id asc", page, pageSize });
      raw.push(...batch.items);
      if (!batch.hasMore) break;
    }
    const alertsPage = await client.list("/Alerts", { orderBy: "AlertDate desc", pageSize: 25 }).catch(() => undefined);

    const now = Date.now();
    const clients = new Map<string, { id: unknown; name: string; total: number; online: number; offline: number; serversOffline: number; rebootNeeded: number }>();
    const attention: Rec[] = [];
    const summary = { total: 0, online: 0, offline: 0, servers: 0, serversOffline: 0, rebootNeeded: 0, stale: 0, avStale: 0, maintenance: 0 };
    for (const item of raw) {
      const r = rec(item);
      const online = computerOnline(r, now);
      const server = String(r.Type ?? "").toLowerCase() === "server";
      const contactDays = daysSince(r.RemoteAgentLastContact, now);
      const avAge = daysSince(r.AntivirusDefinitionDate, now);
      const clientName = String(rec(r.Client).Name ?? "Unknown");
      const entry = clients.get(clientName) ?? { id: rec(r.Client).Id, name: clientName, total: 0, online: 0, offline: 0, serversOffline: 0, rebootNeeded: 0 };
      clients.set(clientName, entry);
      summary.total += 1;
      entry.total += 1;
      if (online) {
        summary.online += 1;
        entry.online += 1;
      } else {
        summary.offline += 1;
        entry.offline += 1;
      }
      if (server) summary.servers += 1;
      const reasons: string[] = [];
      if (server && !online) {
        summary.serversOffline += 1;
        entry.serversOffline += 1;
        reasons.push("server offline");
      }
      if (r.IsRebootNeeded === true) {
        summary.rebootNeeded += 1;
        entry.rebootNeeded += 1;
        reasons.push("reboot pending");
      }
      if (contactDays !== undefined && contactDays >= stale) {
        summary.stale += 1;
        reasons.push(`no contact ${contactDays}d`);
      }
      // AV age only means something on a machine that is still checking in.
      if (online && avAge !== undefined && avAge > av) {
        summary.avStale += 1;
        reasons.push(`AV ${avAge}d old`);
      }
      if (r.IsMaintenanceModeEnabled === true) summary.maintenance += 1;
      if (reasons.length > 0) {
        attention.push({ id: r.Id, name: r.ComputerName, client: clientName, type: r.Type, reasons, lastContact: r.RemoteAgentLastContact });
      }
    }
    return {
      thresholds: { staleDays: stale, avDays: av },
      truncated: raw.length >= max,
      summary,
      clients: [...clients.values()],
      attention: attention.slice(0, 500),
      alerts: (alertsPage?.items ?? []).map((a) => {
        const r = rec(a);
        return { id: r.AlertId, date: r.AlertDate, severity: r.Severity, source: r.Source, message: r.Message };
      }),
    };
  },
};
