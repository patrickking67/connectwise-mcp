import { STATUS_TOOL_SPECS } from "./status.js";
import { PSA_TOOL_SPECS } from "./psa.js";
import { AUTOMATE_TOOL_SPECS } from "./automate.js";
import { CONTROL_TOOL_SPECS } from "./screenconnect.js";
import { AUTOMATE_VIEW_SPECS, CONTROL_VIEW_SPECS, PSA_VIEW_SPECS } from "../apps/index.js";
import { catalogEntry, type CatalogEntry, type ToolSpec, type ToolSurface } from "./spec.js";

/**
 * Every tool this server can register, in registration order, independent of any
 * configuration. The generated docs and the MCPB manifest are built from this, and CI
 * compares it against what an actually-constructed server registers — so the catalog
 * cannot describe a tool surface the server does not have.
 */
export const TOOL_SPECS: ToolSpec[] = [
  ...STATUS_TOOL_SPECS,
  ...PSA_TOOL_SPECS,
  ...PSA_VIEW_SPECS,
  ...AUTOMATE_TOOL_SPECS,
  ...AUTOMATE_VIEW_SPECS,
  ...CONTROL_TOOL_SPECS,
  ...CONTROL_VIEW_SPECS,
];

export const TOOL_CATALOG: CatalogEntry[] = TOOL_SPECS.map(catalogEntry);

/** The tools a server registers when exactly these surfaces are configured (`server` is always on). */
export function toolsForSurfaces(surfaces: ToolSurface[]): ToolSpec[] {
  const on = new Set<ToolSurface>(["server", ...surfaces]);
  return TOOL_SPECS.filter((spec) => on.has(spec.surface));
}
