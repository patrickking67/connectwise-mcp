// The HTML shell every interactive view is built on.
//
// A view is one HTML document the host renders in a sandboxed iframe next to
// the tool result. It receives the tool's arguments and result over postMessage
// (the MCP Apps protocol, spoken by the inlined ext-apps runtime), renders them,
// and may call back into this server's tools — the same guarded tools the model
// uses, so a button in a view can never do more than the model could.
//
// No framework, no build step, no CDN: each view is a template string with a
// small vanilla-JS render function. The shell contributes the runtime, the theme
// variables the host supplies (with a prefers-color-scheme fallback for hosts
// that send none), a handful of shared styles, and `boot()`, which wires the
// protocol events to the view's render function. On ChatGPT, where the Apps SDK
// exposes `window.openai` instead of the MCP Apps channel, `boot()` reads the
// tool output and routes tool calls through that object instead.

import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { APP_RUNTIME } from "./generated/runtime.js";
import { uiResult } from "../lib/format.js";
import { registerSpecTool, toolTitle, type ToolSpec } from "../tools/spec.js";
import { SERVER_VERSION } from "../version.js";

export const VIEW_MIME_TYPE = RESOURCE_MIME_TYPE;

/** `cw_view_board` -> `ui://connectwise/board.html`; `cw_automate_view_computers` -> `.../automate-computers.html`. */
export function viewUri(name: string): string {
  const slug = name
    .replace(/^cw_/, "")
    .replace(/(^|_)(view|get)_/, "$1")
    .replace(/_/g, "-");
  return `ui://connectwise/${slug}.html`;
}

const BASE_CSS = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb; --accent:#0559c9; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; --radius:10px; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#111214; --fg:#f3f4f6; --muted:#9ca3af; --line:#2a2d33; --card:#1a1c20; --accent:#5aa0ff; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; } }
:root[data-theme="dark"] { --bg:#111214; --fg:#f3f4f6; --muted:#9ca3af; --line:#2a2d33; --card:#1a1c20; --accent:#5aa0ff; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; }
* { box-sizing:border-box; }
html,body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 var(--font-sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif); }
body { padding:12px; }
h1 { font-size:16px; margin:0 0 10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
h1 .badge { font-weight:500; }
h2 { font-size:13px; margin:14px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; background:var(--card); border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
.badge.ok { color:var(--ok); border-color:var(--ok); }
.badge.warn { color:var(--warn); border-color:var(--warn); }
.badge.bad { color:var(--bad); border-color:var(--bad); }
.badge.accent { color:var(--accent); border-color:var(--accent); }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px,1fr)); gap:10px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:10px 12px; }
.card .title { font-weight:600; display:flex; justify-content:space-between; gap:8px; align-items:center; }
.card .meta { color:var(--muted); font-size:12px; margin-top:4px; }
.card .big { font-size:22px; font-weight:600; line-height:1.2; margin-top:2px; }
.kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:12px; margin:6px 0 0; }
.kv dt { color:var(--muted); } .kv dd { margin:0; overflow-wrap:anywhere; }
.tablewrap { max-height:420px; overflow:auto; border:1px solid var(--line); border-radius:var(--radius); }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
td.wrap { white-space:normal; overflow-wrap:anywhere; }
th { color:var(--muted); font-weight:500; cursor:pointer; user-select:none; position:sticky; top:0; background:var(--card); z-index:1; }
th.sorted::after { content:" \\2193"; } th.sorted.asc::after { content:" \\2191"; }
tr.clickable { cursor:pointer; } tr.clickable:hover td { background:var(--card); }
.toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 10px; }
input, select, button, textarea { font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:6px 10px; }
input[type=search] { min-width:180px; }
textarea { width:100%; min-height:64px; resize:vertical; }
button { cursor:pointer; } button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
button:disabled { opacity:.5; cursor:default; }
.empty, .error { color:var(--muted); padding:20px; text-align:center; }
.error { color:var(--bad); }
.muted { color:var(--muted); }
.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size:12px; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.status { font-size:12px; color:var(--muted); } .status.ok { color:var(--ok); } .status.err { color:var(--bad); }
.panel { border:1px solid var(--line); border-radius:var(--radius); padding:10px 12px; margin-top:10px; background:var(--bg); }
.panel .close { float:right; }
.note { border-left:2px solid var(--line); padding:0 0 0 10px; margin-bottom:8px; }
.note .head { color:var(--muted); font-size:12px; }
.note .body { white-space:pre-wrap; overflow-wrap:anywhere; }
.bar { height:6px; border-radius:3px; background:var(--line); overflow:hidden; } .bar > span { display:block; height:100%; background:var(--accent); }
`;

/** Shared browser-side helpers, injected into every view before its own script. */
const BOOT_JS = `
const { App, applyHostStyleVariables, applyHostFonts, applyDocumentTheme } = globalThis.__mcpApps;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const fmtBytes = (n) => { if (n == null) return '—'; const u = ['B','KB','MB','GB','TB']; let i = 0; let v = Number(n); while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; } return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i]; };
const fmtAgo = (iso) => { if (!iso) return '—'; const t = new Date(iso).getTime(); if (isNaN(t)) return String(iso); const s = Math.max(0, (Date.now() - t) / 1000); if (s < 90) return Math.round(s) + 's ago'; if (s < 5400) return Math.round(s / 60) + 'm ago'; if (s < 172800) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; };
const fmtWhen = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(); };
const fmtHours = (h) => (h == null ? '—' : Number(h).toFixed(2) + ' h');
const named = (v) => (v && typeof v === 'object' ? (v.name ?? v.identifier ?? v.id ?? '') : (v ?? ''));
const stateClass = (s) => { const v = String(s ?? '').toUpperCase(); if (['ONLINE','CONNECTED','ACTIVE','UP','OPEN','YES','TRUE'].includes(v)) return 'ok'; if (['OFFLINE','DISCONNECTED','DOWN','ERROR','INACTIVE'].includes(v)) return 'bad'; return v ? 'warn' : ''; };
const priorityClass = (p) => { const v = String(p ?? '').toLowerCase(); if (/1|critical|emergency/.test(v)) return 'bad'; if (/2|high/.test(v)) return 'warn'; return ''; };
/** A sortable, filterable table. columns: [{key, label, render?, sort?}]; opts: {sortKey, asc, filter, filters:[{key,label}], onRow, empty} */
function table(root, rows, columns, opts = {}) {
  const state = { sortKey: opts.sortKey ?? columns[0].key, asc: opts.asc ?? true, filter: opts.filter ?? '', picks: {} };
  const facets = (opts.filters ?? []).map((f) => ({ ...f, values: Array.from(new Set(rows.map((r) => r[f.key]).filter((v) => v != null && v !== ''))).sort() }));
  const draw = () => {
    const q = state.filter.toLowerCase();
    const shown = rows
      .filter((r) => !q || columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q)))
      .filter((r) => facets.every((f) => !state.picks[f.key] || String(r[f.key] ?? '') === state.picks[f.key]))
      .sort((a, b) => { const col = columns.find((c) => c.key === state.sortKey); const x = col?.sort ? col.sort(a) : a[state.sortKey]; const y = col?.sort ? col.sort(b) : b[state.sortKey]; const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? '')); return state.asc ? c : -c; });
    root.innerHTML = '<div class="toolbar"><input type="search" placeholder="Filter…" value="' + esc(state.filter) + '">'
      + facets.map((f) => '<select data-facet="' + esc(f.key) + '"><option value="">All ' + esc(f.label) + '</option>' + f.values.map((v) => '<option' + (state.picks[f.key] === String(v) ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select>').join('')
      + '<span class="muted">' + shown.length + ' of ' + rows.length + '</span></div>'
      + '<div class="tablewrap"><table><thead><tr>' + columns.map((c) => '<th data-key="' + esc(c.key) + '" class="' + (c.key === state.sortKey ? 'sorted' + (state.asc ? ' asc' : '') : '') + '">' + esc(c.label) + '</th>').join('') + '</tr></thead>'
      + '<tbody>' + (shown.map((r, i) => '<tr data-i="' + rows.indexOf(r) + '"' + (opts.onRow ? ' class="clickable"' : '') + '>' + columns.map((c) => '<td' + (c.wrap ? ' class="wrap"' : '') + '>' + (c.render ? c.render(r[c.key], r) : esc(r[c.key] ?? '—')) + '</td>').join('') + '</tr>').join('') || '<tr><td colspan="' + columns.length + '" class="empty">' + esc(opts.empty ?? 'Nothing matches.') + '</td></tr>') + '</tbody></table></div>';
    $('input', root).oninput = (e) => { state.filter = e.target.value; draw(); $('input', root).focus(); };
    $$('select[data-facet]', root).forEach((s) => { s.onchange = () => { state.picks[s.dataset.facet] = s.value; draw(); }; });
    $$('th', root).forEach((th) => { th.onclick = () => { const k = th.dataset.key; if (state.sortKey === k) state.asc = !state.asc; else { state.sortKey = k; state.asc = true; } draw(); }; });
    if (opts.onRow) $$('tr.clickable', root).forEach((tr) => { tr.onclick = () => opts.onRow(rows[Number(tr.dataset.i)]); });
  };
  draw();
}
function applyContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.fonts) applyHostFonts(ctx.styles.fonts);
}
/** Unwrap a tool result: structuredContent first, else the JSON in its text part. */
function resultData(result) {
  if (!result) return null;
  const text = (result.content ?? []).find((p) => p.type === 'text')?.text;
  if (result.isError) { let m = text ?? 'tool failed'; try { m = JSON.parse(text).error ?? m; } catch {} throw new Error(m); }
  if (result.structuredContent) return result.structuredContent;
  try { return JSON.parse(text ?? 'null'); } catch { return text; }
}
/** Wire the host to a view: render(root, view) runs on each result; view.call(name, args) reaches this server's tools. */
async function boot(render) {
  const root = $('#app');
  const view = { app: null, input: {}, data: null, call: null, redraw: null };
  const draw = () => { try { render(root, view); } catch (e) { root.innerHTML = '<div class="error">' + esc(e.message) + '</div>'; } };
  view.redraw = draw;
  const openai = globalThis.openai;
  if (openai && typeof openai.callTool === 'function') {
    // ChatGPT Apps SDK host: the tool output and tool calls go through window.openai.
    view.call = async (name, args) => resultData(await openai.callTool(name, args ?? {}));
    const sync = () => { const o = globalThis.openai; if (!o) return; if (o.theme) applyDocumentTheme(o.theme); if (o.toolInput) view.input = o.toolInput; if (o.toolOutput) { view.data = o.toolOutput; draw(); } };
    window.addEventListener('openai:set_globals', sync);
    sync();
    return view;
  }
  const app = new App({ name: 'connectwise', version: ${JSON.stringify(SERVER_VERSION)} }, {}, { autoResize: true });
  view.app = app;
  view.call = async (name, args) => resultData(await app.callServerTool({ name, arguments: args ?? {} }));
  app.ontoolinput = (p) => { view.input = p.arguments ?? {}; };
  app.ontoolresult = (p) => { try { view.data = resultData(p); } catch (e) { root.innerHTML = '<div class="error">' + esc(e.message) + '</div>'; return; } draw(); };
  app.onhostcontextchanged = (ctx) => { applyContext(ctx); };
  await app.connect();
  applyContext(app.getHostContext());
  return view;
}
`;

export interface ViewPage {
  /** Extra CSS for this view. */
  css?: string;
  /** The view's own script; runs after BOOT_JS in the same module scope and must call boot(render). */
  script: string;
}

/** Render a complete HTML document for a view. */
export function renderPage(title: string, page: ViewPage): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}${page.css ?? ""}</style>
</head>
<body>
<div id="app"><div class="empty">Loading…</div></div>
<script type="module">
${APP_RUNTIME}
${BOOT_JS}
${page.script}
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** A view's spec: a read tool whose `ui` is derived from its name. */
export function viewSpec(spec: Omit<ToolSpec, "kind" | "ui">): ToolSpec {
  return { ...spec, kind: "read", ui: viewUri(spec.name) };
}

export interface ViewDefinition<Args extends Record<string, z.ZodTypeAny>, Client> {
  /** The tool spec; `ui` is filled in by `viewSpec`. */
  spec: ToolSpec;
  description: string;
  inputSchema: Args;
  page: ViewPage;
  /** Assemble the data the view renders. Returned as structuredContent and as JSON text. */
  load: (args: z.infer<z.ZodObject<Args>>, client: Client) => Promise<Record<string, unknown>>;
}

/** Register one view: its read tool (through the one registration path) and the ui:// resource it renders. */
export function registerView<Args extends Record<string, z.ZodTypeAny>, Client>(
  server: McpServer,
  view: ViewDefinition<Args, Client>,
  client: Client,
): void {
  const uri = view.spec.ui ?? viewUri(view.spec.name);
  const title = toolTitle(view.spec);
  const html = renderPage(view.spec.pageTitle ?? `ConnectWise — ${title}`, view.page);
  registerAppResource(
    server,
    view.spec.name,
    uri,
    {
      title,
      description: `${title} view`,
      // No network, no CDN: everything the view needs is in the document.
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
    },
    async () => ({ contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: html }] }),
  );
  registerSpecTool<z.infer<z.ZodObject<Args>>>(
    server,
    { ...view.spec, ui: uri },
    { description: view.description, inputSchema: view.inputSchema },
    async (args) => uiResult(await view.load(args, client)),
  );
}
