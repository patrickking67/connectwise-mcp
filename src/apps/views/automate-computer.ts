// One Automate computer in detail: identity, health, drives, patch compliance,
// alerts and recent script runs — plus a Run script panel and a Reboot button.
// Both buttons call this server's own gated write tools (cw_automate_run_script,
// cw_automate_reboot_computer) with confirm: true after an inline second click,
// so the view can never do more than the write gate allows; in read mode the
// tool's refusal, which names the setting, is shown in place.
import { z } from "zod";
import type { AutomateClient } from "../../lib/automate-client.js";
import { viewSpec, type ViewDefinition } from "../shell.js";
import { computerOnline } from "./automate-computers.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const settle = <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);

export const AUTOMATE_COMPUTER_VIEW: ViewDefinition<{ id: z.ZodNumber }, AutomateClient> = {
  spec: viewSpec({
    name: "cw_automate_view_computer",
    title: "View Automate Computer",
    summary: "Interactive detail of one Automate computer with drives, patching, alerts, script history and Run script / Reboot buttons",
    surface: "automate",
    invoking: "Loading the computer…",
    invoked: "Computer loaded.",
  }),
  description:
    "Interactive detail of one ConnectWise Automate computer by id: status, OS, last contact, memory, reboot-needed, antivirus, drive space bars, patch compliance, newest alerts and recent script runs. Includes a Run script panel and a Reboot button that call cw_automate_run_script / cw_automate_reboot_computer (gated: they refuse unless CW_AUTOMATE_MODE=write, and reboot also needs CW_AUTOMATE_ALLOW_DESTRUCTIVE=true). Hosts without MCP Apps get the same data as JSON.",
  inputSchema: {
    id: z.coerce.number().int().describe("Automate computer id (cw_automate_search_computers)") as unknown as z.ZodNumber,
  },
  page: {
    css: `.dangerzone { display:flex; gap:8px; flex-wrap:wrap; align-items:center; } button.danger { color:var(--bad); border-color:var(--bad); } button.danger.armed { background:var(--bad); color:#fff; }`,
    script: `
boot((root, view) => {
  const d = view.data; const c = d.computer;
  const pct = (free, size) => (size ? Math.round(100 * (size - free) / size) : 0);
  const gb = (mb) => (mb == null ? '—' : (mb / 1024).toFixed(mb >= 10240 ? 0 : 1) + ' GB');
  const p = d.patching;
  root.innerHTML = '<h1>' + esc(c.name) + ' <span class="badge ' + (c.online ? 'ok' : 'bad') + '">' + (c.online ? 'online' : 'offline') + '</span>'
    + '<span class="badge">' + esc(c.type ?? '—') + '</span>' + (c.rebootNeeded ? '<span class="badge warn">reboot pending</span>' : '') + (c.maintenance ? '<span class="badge accent">maintenance</span>' : '')
    + (d.alerts.length ? '<span class="badge bad">' + d.alerts.length + ' alerts</span>' : '') + '</h1>'
    + '<div class="grid">'
    + '<div class="card"><div class="title">Identity</div><dl class="kv">' + [['Client', c.client], ['Location', c.location], ['OS', c.os], ['Version', c.osVersion], ['Domain', c.domain], ['IP', c.ip], ['Last user', c.lastUser], ['Serial', c.serial], ['Agent', c.agentVersion]].filter((x) => x[1]).map((x) => '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>').join('') + '</dl></div>'
    + '<div class="card"><div class="title">Health</div><dl class="kv">' + [['Last contact', fmtAgo(c.lastContact)], ['Last startup', fmtWhen(c.lastStartup)], ['CPU', c.cpu != null ? c.cpu + '%' : null], ['Memory', c.totalMemory ? fmtBytes(c.totalMemory - (c.freeMemory ?? 0)) + ' of ' + fmtBytes(c.totalMemory) : null], ['Antivirus', c.antivirus], ['AV definitions', c.avDate ? fmtAgo(c.avDate) : null], ['Windows Update', c.windowsUpdate ? fmtAgo(c.windowsUpdate) : null]].filter((x) => x[1]).map((x) => '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>').join('') + '</dl></div>'
    + '<div class="card"><div class="title">Patching</div>' + (p ? '<div class="big" style="color:var(--' + (p.OverallCompliance >= 95 ? 'ok' : p.OverallCompliance >= 80 ? 'warn' : 'bad') + ')">' + esc(p.OverallCompliance ?? '—') + '%</div><dl class="kv"><dt>Installed</dt><dd>' + esc(p.InstalledPatchCount) + '</dd><dt>Missing</dt><dd>' + esc(p.MissingPatchCount) + '</dd><dt>Failed</dt><dd>' + esc(p.FailedPatchCount) + '</dd><dt>Last patched</dt><dd>' + esc(fmtAgo(p.LastPatchedDate)) + '</dd></dl>' : '<div class="muted">No patch data</div>') + '</div>'
    + '</div>'
    + '<h2>Drives</h2><div class="grid">' + (d.drives.map((x) => '<div class="card"><div class="title"><span>' + esc(x.letter) + ': ' + esc(x.label ?? '') + '</span><span class="badge ' + (pct(x.free, x.size) >= 90 ? 'bad' : pct(x.free, x.size) >= 80 ? 'warn' : '') + '">' + pct(x.free, x.size) + '%</span></div><div class="bar"><span style="width:' + pct(x.free, x.size) + '%;' + (pct(x.free, x.size) >= 90 ? 'background:var(--bad)' : '') + '"></span></div><div class="meta">' + gb(x.free) + ' free of ' + gb(x.size) + ' · ' + esc(x.fs ?? '') + (x.smart && x.smart !== 'OK' ? ' · SMART ' + esc(x.smart) : '') + '</div></div>').join('') || '<div class="muted">No drives reported</div>') + '</div>'
    + '<h2>Actions</h2><div class="panel"><div class="row"><input type="search" id="q" placeholder="Find a script…"><button id="find">Find scripts</button><span class="muted">Runs through cw_automate_run_script (write gate applies)</span></div><div id="scripts"></div>'
    + '<div class="dangerzone" style="margin-top:10px"><button class="danger" id="reboot">Reboot…</button><span class="status" id="rebootStatus"></span></div></div>'
    + '<h2>Alerts</h2><div id="alerts"></div><h2>Recent scripts</h2><div id="history"></div>';
  table($('#alerts'), d.alerts, [
    { key: 'date', label: 'When', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.date ?? 0).getTime() },
    { key: 'severity', label: 'Severity', render: (v) => '<span class="badge ' + stateClass(v) + '">' + esc(v ?? '—') + '</span>' },
    { key: 'source', label: 'Source' }, { key: 'message', label: 'Message', wrap: true },
  ], { sortKey: 'date', asc: false, empty: 'No alerts.' });
  table($('#history'), d.scriptHistory, [
    { key: 'date', label: 'When', render: (v) => esc(fmtAgo(v)), sort: (r) => new Date(r.date ?? 0).getTime() },
    { key: 'name', label: 'Script' }, { key: 'user', label: 'By' },
    { key: 'state', label: 'Result', render: (v, r) => '<span class="badge ' + (/fail|error/i.test(String(v) + r.status) ? 'bad' : /success|complete/i.test(String(v) + r.status) ? 'ok' : '') + '">' + esc(v ?? r.status ?? '—') + '</span>' },
    { key: 'message', label: 'Message', wrap: true },
  ], { sortKey: 'date', asc: false, empty: 'No script history.' });

  // Two clicks for anything that acts: the first arms the button, the second sends confirm: true.
  const arm = (btn, label, act) => { let armed = false; btn.onclick = async () => { if (!armed) { armed = true; btn.classList.add('armed'); btn.textContent = label; setTimeout(() => { armed = false; btn.classList.remove('armed'); btn.textContent = btn.dataset.idle; }, 6000); return; } btn.disabled = true; try { await act(); } finally { btn.disabled = false; armed = false; btn.classList.remove('armed'); btn.textContent = btn.dataset.idle; } }; };
  const rb = $('#reboot'); rb.dataset.idle = 'Reboot…';
  arm(rb, 'Click again to reboot ' + c.name, async () => {
    const st = $('#rebootStatus'); st.className = 'status'; st.textContent = 'Queuing reboot…';
    try { const r = await view.call('cw_automate_reboot_computer', { computerId: Number(c.id), confirm: true }); st.className = 'status ok'; st.textContent = 'Reboot queued (command ' + (r.commandExecuteId ?? '?') + ').'; }
    catch (e) { st.className = 'status err'; st.textContent = e.message; }
  });
  const findScripts = async () => {
    const box = $('#scripts'); box.innerHTML = '<div class="muted">Loading scripts…</div>';
    try {
      const r = await view.call('cw_automate_list_scripts', { name: $('#q').value || undefined, pageSize: 50 });
      const items = r.items ?? [];
      box.innerHTML = items.length ? '<div class="tablewrap" style="max-height:240px;margin-top:8px"><table><tbody>' + items.map((s, i) => '<tr><td class="wrap">' + esc(s.Name) + '<div class="muted">' + esc(s.FullFolderPath ?? '') + '</div></td><td><button data-i="' + i + '" data-idle="Run">Run</button> <span class="status" id="st' + i + '"></span></td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">No computer scripts match.</div>';
      $$('button[data-i]', box).forEach((btn) => { const s = items[Number(btn.dataset.i)]; arm(btn, 'Run on ' + c.name + '?', async () => {
        const st = $('#st' + btn.dataset.i); st.className = 'status'; st.textContent = 'Queuing…';
        try { await view.call('cw_automate_run_script', { computerIds: [Number(c.id)], scriptId: Number(s.Id), confirm: true }); st.className = 'status ok'; st.textContent = 'Queued.'; }
        catch (e) { st.className = 'status err'; st.textContent = e.message; }
      }); });
    } catch (e) { box.innerHTML = '<div class="error">' + esc(e.message) + '</div>'; }
  };
  $('#find').onclick = findScripts;
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') findScripts(); };
});`,
  },
  load: async ({ id }, client) => {
    const r = rec(await client.get(`/Computers/${id}`));
    const [drives, patching, alerts, history] = await Promise.all([
      settle(client.list(`/Computers/${id}/Drives`, { condition: "IsMissing = false", pageSize: 50 })),
      settle(client.get(`/Computers/${id}/PatchingStats`)),
      settle(client.list(`/Computers/${id}/Alerts`, { orderBy: "AlertDate desc", pageSize: 20 })),
      settle(client.list(`/Computers/${id}/ScriptHistory`, { orderBy: "HistoryDate desc", pageSize: 15 })),
    ]);
    return {
      computer: {
        id: r.Id,
        name: r.ComputerName,
        online: computerOnline(r),
        type: r.Type,
        client: rec(r.Client).Name,
        clientId: rec(r.Client).Id,
        location: rec(r.Location).Name,
        os: r.OperatingSystemName,
        osVersion: r.OperatingSystemVersion,
        domain: r.DomainName,
        ip: r.LocalIPAddress,
        lastUser: r.LastUserName,
        serial: r.SerialNumber,
        agentVersion: r.RemoteAgentVersion,
        lastContact: r.RemoteAgentLastContact,
        lastStartup: r.LastStartup,
        cpu: r.CpuUsage,
        totalMemory: r.TotalMemory,
        freeMemory: r.FreeMemory,
        rebootNeeded: r.IsRebootNeeded === true,
        maintenance: r.IsMaintenanceModeEnabled === true,
        antivirus: rec(r.VirusScanner).Name,
        avDate: r.AntivirusDefinitionDate,
        windowsUpdate: r.WindowsUpdateDate,
      },
      // A 0 MB drive is an empty removable slot (floppy, card reader), not a disk.
      drives: (drives?.items ?? [])
        .map((x) => rec(x))
        .filter((x) => Number(x.Size) > 0)
        .map((x) => ({ letter: x.Letter, label: x.VolumeName, size: x.Size, free: x.FreeSpace, fs: x.FileSystem, smart: x.SmartStatus })),
      patching: patching ?? null,
      alerts: (alerts?.items ?? []).map((a) => {
        const x = rec(a);
        return { date: x.AlertDate, severity: x.Severity, source: x.Source, message: x.Message };
      }),
      scriptHistory: (history?.items ?? []).map((h) => {
        const x = rec(h);
        return { date: x.HistoryDate, name: x.Name, user: x.User, status: x.Status, state: x.State, message: x.DiagnosticMessage };
      }),
    };
  },
};
