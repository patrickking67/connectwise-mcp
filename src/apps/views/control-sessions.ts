// Control sessions: the host session list in a table. Control's session
// payload is version-specific, so the rows are normalised defensively.
import { z } from "zod";
import type { ScreenConnectClient } from "../../lib/screenconnect-client.js";
import { viewSpec, type ViewDefinition } from "../shell.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

/** Find the session array inside whatever shape this Control version returns. */
export function extractSessions(payload: unknown): Rec[] {
  if (Array.isArray(payload)) return payload.map(rec);
  const r = rec(payload);
  for (const key of ["Sessions", "sessions", "SessionInfos", "Items", "items"]) {
    if (Array.isArray(r[key])) return (r[key] as unknown[]).map(rec);
  }
  for (const value of Object.values(r)) {
    if (Array.isArray(value) && value.length && typeof value[0] === "object") return value.map(rec);
  }
  return [];
}

const pick = (r: Rec, ...keys: string[]): unknown => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null && v !== "");

export function normaliseSession(r: Rec): Record<string, unknown> {
  const connections = Array.isArray(r.ActiveConnections) ? r.ActiveConnections : Array.isArray(r.Connections) ? r.Connections : [];
  const guestConnected = pick(r, "GuestConnectedCount", "GuestConnected");
  const connected = typeof guestConnected === "number" ? guestConnected > 0 : typeof guestConnected === "boolean" ? guestConnected : connections.length > 0;
  return {
    id: pick(r, "SessionID", "SessionId", "Id"),
    name: pick(r, "Name", "SessionName"),
    machine: pick(r, "GuestMachineName", "MachineName"),
    user: pick(r, "GuestLoggedOnUserName", "GuestLoggedOnUserDomain"),
    os: pick(r, "GuestOperatingSystemName", "OperatingSystemName"),
    connected,
    lastConnected: pick(r, "LastConnectedEventTime", "LastConnected"),
    hostConnections: connections.length,
    group: Array.isArray(r.SessionGroups) ? (r.SessionGroups as unknown[]).join(", ") : pick(r, "SessionGroup", "CustomProperty1"),
  };
}

export const CONTROL_SESSIONS_VIEW: ViewDefinition<
  { sessionType: z.ZodOptional<z.ZodEnum<["Access", "Support", "Meeting"]>> },
  ScreenConnectClient
> = {
  spec: viewSpec({
    name: "cw_control_view_sessions",
    title: "View Control Sessions",
    summary: "Interactive table of Control sessions: machine, user, OS, connected or not, last seen (beta)",
    surface: "control",
    invoking: "Loading Control sessions…",
    invoked: "Sessions loaded.",
  }),
  description:
    "Interactive table of ConnectWise Control (ScreenConnect) host sessions — access machines by default — with connected/disconnected counts, machine, logged-on user, OS and last connection, sortable and filterable. Read-only. BETA: the session payload is Control-version-specific and is normalised best-effort; the raw payload is returned alongside. Hosts without MCP Apps get the same data as JSON.",
  inputSchema: {
    sessionType: z.enum(["Access", "Support", "Meeting"]).optional().describe("Session type (default Access — unattended machines)"),
  },
  page: {
    script: `
boot((root, view) => {
  const d = view.data;
  root.innerHTML = '<h1>Control ' + esc(d.sessionType) + ' sessions <span class="badge">' + d.sessions.length + '</span><span class="badge ok">' + d.summary.connected + ' connected</span>' + (d.summary.disconnected ? '<span class="badge bad">' + d.summary.disconnected + ' disconnected</span>' : '') + '</h1>'
    + (d.sessions.length ? '' : '<div class="empty">No sessions were returned. If this Control version answers with a different shape, use cw_control_api_write to read /Services/PageService.ashx/GetHostSessionInfo directly.</div>')
    + '<div id="t"></div>';
  table($('#t'), d.sessions, [
    { key: 'name', label: 'Session' },
    { key: 'connected', label: 'State', render: (v) => '<span class="badge ' + (v ? 'ok' : 'bad') + '">' + (v ? 'connected' : 'disconnected') + '</span>', sort: (r) => (r.connected ? 1 : 0) },
    { key: 'machine', label: 'Machine' },
    { key: 'user', label: 'User' },
    { key: 'os', label: 'OS', wrap: true },
    { key: 'group', label: 'Group' },
    { key: 'lastConnected', label: 'Last connected', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.lastConnected ?? 0).getTime() },
  ], { sortKey: 'name', filters: [{ key: 'os', label: 'operating systems' }, { key: 'group', label: 'groups' }], empty: 'No sessions match.' });
});`,
  },
  load: async ({ sessionType }, client) => {
    const typeMap = { Support: 0, Meeting: 1, Access: 2 } as const;
    const type = sessionType ?? "Access";
    const raw = await client.listSessions(typeMap[type]);
    const sessions = extractSessions(raw).map(normaliseSession);
    return {
      sessionType: type,
      summary: {
        total: sessions.length,
        connected: sessions.filter((s) => s.connected).length,
        disconnected: sessions.filter((s) => !s.connected).length,
      },
      sessions,
      raw,
    };
  },
};
