import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { safeHandler } from "../lib/format.js";

/**
 * One place that decides what a tool is called, what a person sees it called, and
 * what a client is told it does.
 *
 * Wire names are `cw_`-prefixed snake_case identifiers (`cw_list_boards`); display
 * titles are Title Case prose derived from the name ("List Boards"). MCP carries both:
 * `name` identifies the tool, `title` (and `annotations.title`, which older clients
 * read instead) is what a host puts in front of a person.
 * https://modelcontextprotocol.io/specification/latest/server/tools
 */

/** Which ConnectWise product a tool talks to; `server` tools need no product at all. */
export type ToolSurface = "server" | "psa" | "automate" | "control";

/** The verbs a tool name may carry, by kind — the DivergeIT house convention. */
export const READ_VERBS = ["list", "get", "search", "find", "test", "status", "report", "plan"] as const;
export const WRITE_VERBS = [
  "create", "update", "set", "run", "send", "assign", "sync", "restart", "reboot", "start", "stop",
  "invite", "rotate", "apply", "install", "uninstall", "lock", "wake", "blink", "cycle", "claim",
  "remove", "delete", "wipe", "retire", "clear", "execute", "add",
  // The raw passthrough: cw_api_write / cw_control_api_write, where the kind is
  // the word itself.
  "write",
] as const;
/** The one verb an interactive view may carry. */
export const VIEW_VERB = "view";

/**
 * The verb of a tool name: the first word after the prefix (`cw_`, `cw_automate_`,
 * `cw_control_`). The raw passthroughs are `api_get` / `api_write`, where the
 * kind sits after `api`.
 */
export function toolVerb(name: string): string {
  const words = name.replace(/^cw_(?:automate_|control_)?/, "").split("_");
  return words[0] === "api" ? (words[1] ?? "") : words[0];
}

/** What a tool does to the ConnectWise data behind it. Drives the safety annotations. */
export type ToolKind = "read" | "write";

/** How a tool is presented to a person: the three groups the docs and UI list. */
export type ToolCategory = "read" | "write" | "interactive";

export interface ToolSpec {
  /** Wire name. `cw_` + snake_case. */
  name: string;
  /** Display title. Derived from `name` when omitted. */
  title?: string;
  /** One line of prose for the generated docs and the MCPB manifest. */
  summary: string;
  surface: ToolSurface;
  kind: ToolKind;
  /** Write tools only: the call may overwrite or remove data. Default false. */
  destructive?: boolean;
  /** Write tools only: repeating the call with the same arguments changes nothing more. */
  idempotent?: boolean;
  /** `ui://` resource rendered for this tool's result. Its presence makes the tool interactive. */
  ui?: string;
  /** The card may call this tool itself, not only the model. */
  appAccessible?: boolean;
  /** Ask a person on every call, even where the host would otherwise auto-approve. */
  requiresUserInteraction?: boolean;
  /** Host status line while the tool runs (interactive tools). */
  invoking?: string;
  /** Host status line once it has run (interactive tools). */
  invoked?: string;
  /** Interactive tools: the rendered document's title (defaults to the tool title). */
  pageTitle?: string;
}

/**
 * Every tool name is `cw_` plus lowercase words joined by single underscores.
 * The MCP spec allows more than this; the narrower rule is what keeps the
 * name -> title derivation mechanical.
 */
export const TOOL_NAME_PATTERN = /^cw_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** Words that are not capitalized but shouted, plus the ones Title Case would mangle. */
const WORD_OVERRIDES: Record<string, string> = {
  aks: "AKS",
  api: "API",
  ca: "CA",
  dns: "DNS",
  id: "ID",
  lan: "LAN",
  mfa: "MFA",
  nsg: "NSG",
  os: "OS",
  po: "PO",
  psa: "PSA",
  rbac: "RBAC",
  rmm: "RMM",
  sla: "SLA",
  sql: "SQL",
  ssid: "SSID",
  url: "URL",
  uuid: "UUID",
  vm: "VM",
  vpn: "VPN",
};

/** `cw_list_catalog_categories` -> `List Catalog Categories`. */
export function titleFromName(name: string): string {
  return name
    .replace(/^cw_/, "")
    .split("_")
    .map((word) => WORD_OVERRIDES[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function toolTitle(spec: ToolSpec): string {
  return spec.title ?? titleFromName(spec.name);
}

/** Interactive is a presentation fact; read/write stays the safety fact underneath it. */
export function toolCategory(spec: ToolSpec): ToolCategory {
  return spec.ui ? "interactive" : spec.kind;
}

/**
 * Annotations are set on every tool, never left to default. Hosts that gate on them
 * treat an unannotated tool as destructive (Microsoft 365 Copilot does exactly that),
 * and Claude only parallelizes calls it has been told are read-only.
 *
 * `openWorldHint` is false throughout: these tools reach one configured ConnectWise
 * instance, not the open internet.
 */
export function annotationsFor(spec: ToolSpec): ToolAnnotations {
  const title = toolTitle(spec);
  if (spec.kind === "read") {
    return {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }
  return {
    title,
    readOnlyHint: false,
    destructiveHint: spec.destructive ?? false,
    idempotentHint: spec.idempotent ?? false,
    openWorldHint: false,
  };
}

/**
 * `_meta` is where the per-host extras live:
 * - `ui.resourceUri` / `openai/outputTemplate` — the MCP Apps card, under both the
 *   standard key and the ChatGPT alias, so one tool renders on both.
 * - `ui.visibility` / `openai/widgetAccessible` — the tools a rendered card is
 *   allowed to call back into.
 * - `anthropic/requiresUserInteraction` — Claude Code prompts on every call and offers
 *   no "don't ask again", which is what the raw write escape hatches deserve.
 */
export function metaFor(spec: ToolSpec): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (spec.ui || spec.appAccessible) {
    // visibility says who may call the tool. A card that posts a note needs "app"
    // on the note tool as well as on the tool that rendered the card.
    meta.ui = {
      ...(spec.ui ? { resourceUri: spec.ui } : {}),
      visibility: ["model", "app"],
    };
    meta["openai/widgetAccessible"] = true;
  }
  if (spec.ui) {
    meta["openai/outputTemplate"] = spec.ui;
    if (spec.invoking) meta["openai/toolInvocation/invoking"] = spec.invoking;
    if (spec.invoked) meta["openai/toolInvocation/invoked"] = spec.invoked;
  }
  if (spec.requiresUserInteraction) meta["anthropic/requiresUserInteraction"] = true;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export interface ToolShape {
  description: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
}

/**
 * Register a tool from its spec: one call site so no tool can be added without a
 * title, a category, and annotations, and so handlers are always wrapped.
 */
export function registerSpecTool<A>(
  server: McpServer,
  spec: ToolSpec,
  shape: ToolShape,
  handler: (args: A) => Promise<CallToolResult>,
): void {
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new Error(`Tool name "${spec.name}" is not cw_ + snake_case`);
  }
  server.registerTool(
    spec.name,
    {
      title: toolTitle(spec),
      description: shape.description,
      inputSchema: shape.inputSchema ?? {},
      annotations: annotationsFor(spec),
      _meta: metaFor(spec),
    },
    safeHandler(handler) as never,
  );
}

export interface CatalogEntry {
  name: string;
  title: string;
  summary: string;
  surface: ToolSurface;
  category: ToolCategory;
  annotations: ToolAnnotations;
}

export function catalogEntry(spec: ToolSpec): CatalogEntry {
  return {
    name: spec.name,
    title: toolTitle(spec),
    summary: spec.summary,
    surface: spec.surface,
    category: toolCategory(spec),
    annotations: annotationsFor(spec),
  };
}
