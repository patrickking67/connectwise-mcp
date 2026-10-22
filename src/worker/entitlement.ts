// What the caller may do, given who Access says they are.
//
// Every tool in this server already declares its tier through MCP annotations:
// readOnlyHint true is a read (the interactive view tools are reads too),
// destructiveHint true is the disruptive write tier, and anything else is a
// write. A tool with no annotations at all is treated as a write - unknown
// fails closed.
//
// The caller gets a tier from the MCP_*_PRINCIPALS vars: a comma-separated list
// of emails, @domains, group names or group ids (commas separate entries, so a
// group name may contain spaces), matched case-insensitively
// against the Access identity. No match means read-only. Destructive implies
// write. A caller never gets more than the vendor gate allows: the gate vars
// (<PREFIX>_MODE, <PREFIX>_ALLOW_DESTRUCTIVE) stay in force inside every tool,
// so this layer narrows per user and the gate is the ceiling for everyone.
//
// Tools above the caller's tier are hidden from tools/list by default, so a
// read-only user sees a clean read-only server rather than a list of tools that
// would refuse. The handler is wrapped as well, so a call to a hidden tool is
// refused with a message naming the var to change - the hiding is a courtesy,
// the wrapper is the control. Every call, allowed or refused, is written to the
// Workers log as one JSON line without its arguments.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccessIdentity } from './access.js';

export type Tier = 'read' | 'write' | 'destructive';

const RANK: Record<Tier, number> = { read: 0, write: 1, destructive: 2 };

export function tierAtLeast(have: Tier, need: Tier): boolean {
  return RANK[have] >= RANK[need];
}

/** The subset of the SDK's RegisteredTool this module touches. */
interface RegisteredToolLike {
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } | undefined;
  enabled: boolean;
  handler: unknown;
}

function registeredTools(server: McpServer): Record<string, RegisteredToolLike> {
  // _registeredTools is private in the SDK; TypeScript privacy is compile-time only,
  // and the registration record is the one place every tool is reachable after the
  // vendor code has registered it. If a future SDK renames it, the test suite catches
  // it on the first run: tools/list would show write tools to a read-only caller.
  const record = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })._registeredTools;
  if (record === undefined) throw new Error('McpServer has no _registeredTools; the SDK layout changed');
  return record;
}

/** Classify one tool from its annotations. Missing annotations fail closed to write. */
export function classifyTool(tool: { annotations?: RegisteredToolLike['annotations'] }): Tier {
  const annotations = tool.annotations;
  if (annotations === undefined || annotations === null) return 'write';
  if (annotations.destructiveHint === true) return 'destructive';
  if (annotations.readOnlyHint === true) return 'read';
  return 'write';
}

export interface Entitlement {
  readonly tier: Tier;
  /** The email the decision was made for. */
  readonly principal: string;
  /** The allowlist entries that matched, for the status tool and the log. */
  readonly matched: readonly string[];
}

export interface EntitlementEnv {
  readonly MCP_READ_PRINCIPALS?: unknown;
  readonly MCP_WRITE_PRINCIPALS?: unknown;
  readonly MCP_DESTRUCTIVE_PRINCIPALS?: unknown;
  readonly MCP_HIDE_UNENTITLED_TOOLS?: unknown;
  readonly [binding: string]: unknown;
}

function parseList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Does one allowlist entry name this identity?
 *   *                 everyone Access let in
 *   @divergeit.com    any email in that domain
 *   name@domain       that email
 *   group:<name|id>   that group, by name or id
 *   <anything else>   a group name or id
 */
export function matchesPrincipal(entry: string, identity: AccessIdentity): boolean {
  const needle = entry.toLowerCase();
  const email = identity.email.toLowerCase();
  if (needle === '*') return true;
  if (needle.startsWith('@')) return email.endsWith(needle);
  if (needle.includes('@')) return email === needle;
  const groupNeedle = needle.startsWith('group:') ? needle.slice('group:'.length) : needle;
  for (const group of identity.groups ?? []) {
    if (group.name.toLowerCase() === groupNeedle || group.id.toLowerCase() === groupNeedle) return true;
    if (typeof group.email === 'string' && group.email.toLowerCase() === groupNeedle) return true;
  }
  return false;
}

function matching(list: unknown, identity: AccessIdentity): string[] {
  return parseList(list).filter((entry) => matchesPrincipal(entry, identity));
}

/**
 * Decide the caller's tier. Returns undefined when MCP_READ_PRINCIPALS is set
 * and the caller matches nothing at all - an explicit read allowlist turns the
 * server into deny-by-default for everyone Access admitted but the list omits.
 */
export function decideEntitlement(identity: AccessIdentity, env: EntitlementEnv): Entitlement | undefined {
  const destructive = matching(env.MCP_DESTRUCTIVE_PRINCIPALS, identity);
  const write = matching(env.MCP_WRITE_PRINCIPALS, identity);
  const read = matching(env.MCP_READ_PRINCIPALS, identity);
  const principal = identity.email;
  if (destructive.length > 0) return { tier: 'destructive', principal, matched: [...destructive, ...write] };
  if (write.length > 0) return { tier: 'write', principal, matched: write };
  if (parseList(env.MCP_READ_PRINCIPALS).length > 0 && read.length === 0) return undefined;
  return { tier: 'read', principal, matched: read };
}

export interface ToolCounts {
  read: number;
  write: number;
  destructive: number;
}

export interface EntitlementSummary {
  readonly visible: ToolCounts;
  readonly hidden: ToolCounts;
  readonly hiddenNames: readonly string[];
}

export interface AuditContext {
  readonly service: string;
  readonly identity: AccessIdentity;
  readonly entitlement: Entitlement;
  /** Where the JSON lines go. Defaults to console.log, which Workers Logs collect. */
  readonly log?: (line: string) => void;
}

function argumentKeys(callArgs: readonly unknown[]): readonly string[] {
  const first = callArgs[0];
  if (callArgs.length >= 2 && typeof first === 'object' && first !== null) return Object.keys(first);
  return [];
}

function refusal(toolName: string, toolTier: Tier, entitlement: Entitlement): { isError: true; content: { type: 'text'; text: string }[] } {
  const variable = toolTier === 'destructive' ? 'MCP_DESTRUCTIVE_PRINCIPALS' : 'MCP_WRITE_PRINCIPALS';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `Refused: ${toolName} is a ${toolTier} tool and ${entitlement.principal} has ${entitlement.tier} access on this server. ` +
          `An operator can grant it by adding the user, their @domain or an Access group to ${variable} on the Worker.`,
      },
    ],
  };
}

/**
 * Wrap and hide tools according to the caller's tier. Call this once per
 * request, on the freshly built server, before it is connected to a transport.
 */
export function applyEntitlement(server: McpServer, audit: AuditContext, env: EntitlementEnv): EntitlementSummary {
  const hide = typeof env.MCP_HIDE_UNENTITLED_TOOLS === 'string' ? env.MCP_HIDE_UNENTITLED_TOOLS.toLowerCase() !== 'false' : true;
  const log = audit.log ?? ((line: string) => console.log(line));
  const visible: ToolCounts = { read: 0, write: 0, destructive: 0 };
  const hidden: ToolCounts = { read: 0, write: 0, destructive: 0 };
  const hiddenNames: string[] = [];
  const { entitlement, identity, service } = audit;

  for (const [name, tool] of Object.entries(registeredTools(server))) {
    const toolTier = classifyTool(tool);
    const allowed = tierAtLeast(entitlement.tier, toolTier);
    if (allowed) visible[toolTier] += 1;
    else {
      hidden[toolTier] += 1;
      hiddenNames.push(name);
      if (hide) tool.enabled = false;
    }

    const original = tool.handler;
    // Task-style handlers (createTask/getTask) are not wrapped; none of these servers use them.
    if (typeof original !== 'function') continue;
    const call = original as (...callArgs: unknown[]) => unknown;
    tool.handler = async (...callArgs: unknown[]): Promise<unknown> => {
      const started = Date.now();
      const base = {
        event: 'mcp.tool_call',
        service,
        tool: name,
        toolTier,
        user: identity.email,
        userTier: entitlement.tier,
        args: argumentKeys(callArgs),
      };
      if (!allowed) {
        log(JSON.stringify({ ...base, outcome: 'refused', ms: 0 }));
        return refusal(name, toolTier, entitlement);
      }
      try {
        const result = await call(...callArgs);
        const toolError = typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
        log(JSON.stringify({ ...base, outcome: toolError ? 'tool_error' : 'ok', ms: Date.now() - started }));
        return result;
      } catch (error) {
        log(JSON.stringify({ ...base, outcome: 'error', ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }));
        throw error;
      }
    };
  }

  return { visible, hidden, hiddenNames: hiddenNames.sort() };
}

export interface SessionStatusInfo {
  readonly service: string;
  readonly version: string;
  readonly identity: AccessIdentity;
  readonly entitlement: Entitlement;
  readonly summary: EntitlementSummary;
  readonly source: string;
  /** Vendor gate vars worth echoing, name to value, already redacted by the caller. */
  readonly gate: Readonly<Record<string, string | undefined>>;
}

/**
 * A read tool that explains the session: who Access says you are, which tier
 * you landed in and why, and how many tools that hides. The first thing to call
 * when a tool you expected is missing.
 */
export function registerSessionStatusTool(server: McpServer, name: string, info: SessionStatusInfo): void {
  const title = 'Session status';
  server.registerTool(
    name,
    {
      title,
      description:
        'Who Cloudflare Access says you are, which access tier (read, write or destructive) this server gave you and why, ' +
        'and how many tools that tier hides from the tool list. Call this first when a tool you expected is missing.',
      annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const groups = (info.identity.groups ?? []).map((group) => group.name);
      const body = {
        service: info.service,
        version: info.version,
        user: {
          email: info.identity.email,
          name: info.identity.name,
          groups,
          identity_source: info.source,
        },
        tier: info.entitlement.tier,
        matched_allowlist_entries: info.entitlement.matched,
        tools: {
          visible: info.summary.visible,
          hidden: info.summary.hidden,
          hidden_names: info.summary.hiddenNames,
        },
        vendor_gate: info.gate,
        how_to_change:
          'Tiers come from MCP_WRITE_PRINCIPALS and MCP_DESTRUCTIVE_PRINCIPALS on the Worker (emails, @domains, Access group names). ' +
          'The vendor gate vars are the ceiling for everyone.',
      };
      return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body };
    },
  );
}
