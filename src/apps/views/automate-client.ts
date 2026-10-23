// One Automate client: its record, locations, and every computer under it
// with online/offline, OS and reboot-pending, in filterable tables. Read-only.
import { z } from "zod";
import type { AutomateClient } from "../../lib/automate-client.js";
import { viewSpec, type ViewDefinition } from "../shell.js";
import { computerOnline } from "./automate-computers.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

export const AUTOMATE_CLIENT_VIEW: ViewDefinition<{ id: z.ZodNumber }, AutomateClient> = {
  spec: viewSpec({
    name: "cw_automate_view_client",
    title: "View Automate Client",
    summary: "Interactive overview of one Automate client: locations, computers online/offline, OS mix, reboots pending",
    surface: "automate",
    invoking: "Loading the client…",
    invoked: "Client loaded.",
  }),
  description:
    "Interactive overview of one ConnectWise Automate client by id: contact details, its locations with computer counts, and every computer with online/offline state, type, OS, last user, reboot-pending and last contact, sortable and filterable. Read-only. Find the id with cw_automate_list_clients. Hosts without MCP Apps get the same data as JSON.",
  inputSchema: {
    id: z.coerce.number().int().describe("Automate client id (cw_automate_list_clients)") as unknown as z.ZodNumber,
  },
  page: {
    script: `
boot((root, view) => {
  const d = view.data; const c = d.client; const s = d.summary;
  root.innerHTML = '<h1>' + esc(c.name) + ' <span class="badge">' + s.total + ' computers</span><span class="badge ok">' + s.online + ' online</span>' + (s.offline ? '<span class="badge bad">' + s.offline + ' offline</span>' : '') + (s.rebootNeeded ? '<span class="badge warn">' + s.rebootNeeded + ' reboot pending</span>' : '') + '</h1>'
    + '<div class="grid">'
    + '<div class="card"><div class="title">Client</div><dl class="kv">' + [['Company', c.company], ['Contact', [c.firstName, c.lastName].filter(Boolean).join(' ')], ['Phone', c.phone], ['Address', [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ')], ['PSA company id', c.externalId]].filter((x) => x[1]).map((x) => '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>').join('') + '</dl></div>'
    + '<div class="card"><div class="title">Servers / workstations</div><div class="big">' + s.servers + ' / ' + s.workstations + '</div><div class="meta">' + s.serversOffline + ' servers offline</div></div>'
    + '<div class="card"><div class="title">Operating systems</div>' + Object.entries(s.byOs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => '<div class="row" style="justify-content:space-between"><span>' + esc(k) + '</span><span class="badge">' + n + '</span></div>').join('') + '</div>'
    + '</div>'
    + '<h2>Locations</h2><div id="locations"></div><h2>Computers</h2><div id="computers"></div>';
  table($('#locations'), d.locations, [
    { key: 'name', label: 'Location' }, { key: 'city', label: 'City' },
    { key: 'computers', label: 'Computers' },
    { key: 'offline', label: 'Offline', render: (v) => '<span class="badge ' + (v ? 'bad' : '') + '">' + v + '</span>' },
  ], { sortKey: 'name', empty: 'No locations.' });
  table($('#computers'), d.computers, [
    { key: 'name', label: 'Name' },
    { key: 'online', label: 'State', render: (v) => '<span class="badge ' + (v ? 'ok' : 'bad') + '">' + (v ? 'online' : 'offline') + '</span>', sort: (r) => (r.online ? 1 : 0) },
    { key: 'type', label: 'Type' }, { key: 'location', label: 'Location' }, { key: 'os', label: 'OS', wrap: true },
    { key: 'lastUser', label: 'Last user' },
    { key: 'rebootNeeded', label: 'Reboot', render: (v) => (v ? '<span class="badge warn">pending</span>' : '') },
    { key: 'lastContact', label: 'Last contact', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.lastContact ?? 0).getTime() },
  ], { sortKey: 'name', filters: [{ key: 'location', label: 'locations' }, { key: 'type', label: 'types' }, { key: 'os', label: 'operating systems' }], empty: 'No computers.', onRow: (r) => view.app?.sendMessage?.({ role: 'user', content: [{ type: 'text', text: 'Open Automate computer ' + r.name + ' (id ' + r.id + ') with cw_automate_view_computer.' }] }) });
});`,
  },
  load: async ({ id }, client) => {
    const c = rec(await client.get(`/Clients/${id}`));
    const computers: Rec[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await client.list("/Computers", {
        condition: `Client.Id = ${id}`,
        includeFields:
          "Id,ComputerName,Location,Type,Status,OperatingSystemName,LastUserName,RemoteAgentLastContact,IsRebootNeeded,LocalIPAddress",
        orderBy: "ComputerName asc",
        page,
        pageSize: 500,
      });
      computers.push(...batch.items.map((x) => rec(x)));
      if (!batch.hasMore) break;
    }
    const now = Date.now();
    const rows = computers.map((r) => ({
      id: r.Id,
      name: r.ComputerName,
      online: computerOnline(r, now),
      type: r.Type,
      location: rec(r.Location).Name,
      locationId: rec(r.Location).Id,
      os: r.OperatingSystemName,
      lastUser: r.LastUserName,
      rebootNeeded: r.IsRebootNeeded === true,
      ip: r.LocalIPAddress,
      lastContact: r.RemoteAgentLastContact,
    }));
    const byOs: Record<string, number> = {};
    for (const r of rows) byOs[String(r.os ?? "Unknown")] = (byOs[String(r.os ?? "Unknown")] ?? 0) + 1;
    const isServer = (r: { type: unknown }) => String(r.type ?? "").toLowerCase() === "server";
    const locations = (Array.isArray(c.Locations) ? c.Locations : []).map((l) => {
      const loc = rec(l);
      const here = rows.filter((r) => String(r.locationId) === String(loc.Id));
      return { id: loc.Id, name: loc.Name, city: loc.City, computers: here.length, offline: here.filter((r) => !r.online).length };
    });
    return {
      client: {
        id: c.Id,
        name: c.Name,
        company: c.Company,
        firstName: c.FirstName,
        lastName: c.LastName,
        phone: c.PhoneNumber,
        address: c.Address1,
        city: c.City,
        state: c.State,
        zip: c.ZipCode,
        externalId: c.ExternalId,
      },
      summary: {
        total: rows.length,
        online: rows.filter((r) => r.online).length,
        offline: rows.filter((r) => !r.online).length,
        servers: rows.filter(isServer).length,
        workstations: rows.filter((r) => !isServer(r)).length,
        serversOffline: rows.filter((r) => isServer(r) && !r.online).length,
        rebootNeeded: rows.filter((r) => r.rebootNeeded).length,
        byOs,
      },
      locations,
      computers: rows,
    };
  },
};
