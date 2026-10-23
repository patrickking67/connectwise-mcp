// The write gate.
//
// Three independent checks stand between a model and a change in a live
// ConnectWise tenant, and the first two can only be opened by a person editing
// the client configuration:
//
//   1. <PREFIX>_MODE must be "write" (or "true", which is what a Claude Desktop
//      boolean field sends). Default: read.
//   2. <PREFIX>_ALLOW_DESTRUCTIVE must be "true" for the disruptive tier — the
//      tools annotated destructiveHint: true: reboots, shutdowns, service stops,
//      deletions, and the raw *_api_write passthroughs that can do any of those.
//   3. Every write call carries confirm: true. The env vars are the operator's
//      standing policy; confirm is the model stating, per call, that it means
//      this specific change.
//
// Write tools stay REGISTERED in read mode and refuse with a message naming the
// setting. A tool that vanishes reads as a broken install; a refusal that names
// the setting is something an operator can act on. cw_status_gate reports the
// state of every gate.
//
// <PREFIX> is CW_PSA for PSA tools and CW_AUTOMATE for Automate tools.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GATE_PREFIX, PRODUCT_LABEL, type GateProduct, type WriteGate } from "../config.js";

/** The gates each server was built with. A server with none bound is read-only. */
const BOUND = new WeakMap<McpServer, Partial<Record<GateProduct, WriteGate>>>();

export function bindGates(server: McpServer, gates: Partial<Record<GateProduct, WriteGate>> | undefined): void {
  BOUND.set(server, gates ?? {});
}

const CLOSED: WriteGate = { write: false, destructive: false };

export function gateFor(server: McpServer, product: GateProduct): WriteGate {
  return BOUND.get(server)?.[product] ?? CLOSED;
}

/** Claude Desktop field titles for the gate switches, so a refusal points at the form. */
export const GATE_FIELDS: Record<GateProduct, { mode: string; destructive: string }> = {
  psa: { mode: "PSA write mode", destructive: "PSA allow destructive" },
  automate: { mode: "Automate write mode", destructive: "Automate allow destructive" },
};

/** The parameter every write tool carries. Optional in the schema so a missing value gets a helpful refusal, not a schema error. */
export const confirmParam = z
  .boolean()
  .optional()
  .describe(
    "Must be exactly true: explicit acknowledgement that this call changes live ConnectWise data. There is no dry run.",
  );

export interface GateCheck {
  tool: string;
  product: GateProduct;
  destructive: boolean;
  confirm: unknown;
}

/** Why a write must not run, or undefined when every gate is open. */
export function gateRefusal(gate: WriteGate, check: GateCheck): string | undefined {
  const prefix = GATE_PREFIX[check.product];
  const fields = GATE_FIELDS[check.product];
  const label = PRODUCT_LABEL[check.product];
  if (!gate.write) {
    return (
      `${check.tool} is a write tool and ${label} is in read mode. To allow writes, set ${prefix}_MODE=write ` +
      `(Claude Desktop: Settings > Extensions field "${fields.mode}") and restart. Nothing was changed.`
    );
  }
  if (check.destructive && !gate.destructive) {
    return (
      `${check.tool} is in the disruptive tier and needs a second switch: set ${prefix}_ALLOW_DESTRUCTIVE=true ` +
      `(Settings > Extensions field "${fields.destructive}") on top of ${prefix}_MODE=write, and restart. Nothing was changed.`
    );
  }
  if (check.confirm !== true) {
    return `${check.tool} changes live ${label} data and needs confirm: true on the call. Nothing was changed.`;
  }
  return undefined;
}

/** The gate state as cw_status_gate reports it. */
export function gateReport(server: McpServer, products: GateProduct[]): Record<string, unknown> {
  return {
    products: products.map((product) => {
      const gate = gateFor(server, product);
      const prefix = GATE_PREFIX[product];
      return {
        product: PRODUCT_LABEL[product],
        mode: gate.write ? "write" : "read",
        modeEnvVar: `${prefix}_MODE`,
        modeSettingsField: GATE_FIELDS[product].mode,
        destructiveAllowed: gate.destructive,
        destructiveEnvVar: `${prefix}_ALLOW_DESTRUCTIVE`,
        destructiveSettingsField: GATE_FIELDS[product].destructive,
      };
    }),
    note:
      "Write tools stay listed in read mode and refuse with a message naming the setting. The disruptive tier " +
      "(destructiveHint: true — reboot, shutdown, service stop, deletes, raw *_api_write) also needs ALLOW_DESTRUCTIVE. " +
      "Every write call additionally needs confirm: true.",
  };
}
