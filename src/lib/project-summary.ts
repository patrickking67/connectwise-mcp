// Shared by cw_get_project and the cw_view_project view.

/** Project tickets per phase, open vs closed, with budget and actual hours. */
export function summarizeProjectTickets(rows: Array<Record<string, unknown>>): {
  total: number;
  open: number;
  closed: number;
  byPhase: Array<{ phase: string; open: number; closed: number; budgetHours: number; actualHours: number }>;
} {
  const phases = new Map<string, { phase: string; open: number; closed: number; budgetHours: number; actualHours: number }>();
  let open = 0;
  for (const row of rows) {
    const phase = String((row.phase as { name?: string } | undefined)?.name ?? "(no phase)");
    const entry = phases.get(phase) ?? { phase, open: 0, closed: 0, budgetHours: 0, actualHours: 0 };
    phases.set(phase, entry);
    if (row.closedFlag === true) entry.closed += 1;
    else {
      entry.open += 1;
      open += 1;
    }
    entry.budgetHours += Number(row.budgetHours ?? 0);
    entry.actualHours += Number(row.actualHours ?? 0);
  }
  return { total: rows.length, open, closed: rows.length - open, byPhase: [...phases.values()] };
}
