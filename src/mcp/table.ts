/** Plain-text tables for MCP tool replies (the same layout agents already see from OpenSEO). */
export type Column<T> = { header: string; value: (row: T) => unknown; format?: (v: unknown) => string };

export function cell(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return !Number.isFinite(value) ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "bigint") return value.toString();
  try { return JSON.stringify(value) ?? "—"; } catch { return "—"; }
}

export const truncated = (max: number) => (v: unknown) => {
  const c = cell(v);
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
};

export function table<T>(rows: readonly T[], cols: readonly Column<T>[]): string {
  return [cols.map((c) => c.header).join(" | "), ...rows.map((r) => cols.map((c) => (c.format ? c.format(c.value(r)) : cell(c.value(r)))).join(" | "))].join("\n");
}

export function readPath(source: unknown, ...path: string[]): unknown {
  let cur = source;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function pick(row: unknown, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) { const v = readPath(row, f); if (v !== undefined) out[f] = v; }
  return out;
}
