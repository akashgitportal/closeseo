import { AsyncLocalStorage } from "node:async_hooks";
import type { Ctx } from "../ctx.ts";
import { newId, nowIso } from "../db.ts";
import { AppError } from "../errors.ts";

/**
 * Spend ledger and monthly budgets.
 *
 * CloseSEO has no payment processing: the owner pays DataForSEO and OpenRouter directly. What it can do is
 * record every billed call, attribute it to a project and a feature, and refuse new paid calls once a
 * monthly cap is reached. A call that is already in flight is not interrupted, so a cap can be exceeded by
 * the calls that were started together (at most one prompt-explorer fan-out of four models).
 */

export type UsageScope = { projectId?: string | null; feature?: string; /** Optional running total of the spend made inside this scope. */ meter?: { usd: number } };
const scope = new AsyncLocalStorage<UsageScope>();

/** Run `fn` so that every paid call made inside it is attributed to this project/feature. */
export const withUsage = <T>(s: UsageScope, fn: () => T): T => {
  const parent = scope.getStore();
  // A nested scope keeps what the outer one decided (the assistant owns the feature of the tools it calls).
  return scope.run({ projectId: s.projectId ?? parent?.projectId ?? null, feature: s.feature ?? parent?.feature, meter: s.meter ?? parent?.meter }, fn);
};

export const FEATURES: Record<string, string> = {
  keywords: "Keyword research", domain: "Domain & competitors", backlinks: "Backlinks", serp: "SERP",
  rank_tracking: "Rank tracking", ai_visibility: "AI visibility", local: "Local business", audit: "Site audit",
  assistant: "Assistant", other: "Other",
};

function featureOfPath(path: string): string {
  if (path.startsWith("/v3/ai_optimization")) return "ai_visibility";
  if (path.startsWith("/v3/backlinks")) return "backlinks";
  if (path.startsWith("/v3/serp/google/maps") || path.startsWith("/v3/serp/google/local_finder")) return "local";
  if (path.startsWith("/v3/serp")) return "serp";
  if (path.startsWith("/v3/business_data")) return "local";
  if (path.startsWith("/v3/on_page")) return "audit";
  if (path.includes("ranked_keywords") || path.includes("serp_competitors") || path.includes("domain_rank")) return "domain";
  if (path.startsWith("/v3/dataforseo_labs") || path.startsWith("/v3/keywords_data")) return "keywords";
  return "other";
}

type Spend = { provider: "dataforseo" | "openrouter"; endpoint: string; costUsd: number; feature?: string; projectId?: string | null };

export function recordSpend(ctx: Ctx, s: Spend) {
  if (!(s.costUsd > 0)) return;
  const cur = scope.getStore();
  if (cur?.meter) cur.meter.usd += s.costUsd;
  const feature = s.feature ?? cur?.feature ?? (s.provider === "openrouter" ? "assistant" : featureOfPath(s.endpoint));
  const projectId = s.projectId !== undefined ? s.projectId : (cur?.projectId ?? null);
  try {
    ctx.db.prepare("INSERT INTO usage_events (id,project_id,provider,feature,endpoint,cost_usd,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(newId(), projectId, s.provider, feature, s.endpoint, s.costUsd, nowIso());
  } catch (e) {
    // The project can be deleted while one of its calls is in flight; the spend is still real, so keep it unattributed.
    if (projectId) ctx.db.prepare("INSERT INTO usage_events (id,project_id,provider,feature,endpoint,cost_usd,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(newId(), null, s.provider, feature, s.endpoint, s.costUsd, nowIso());
    else throw e;
  }
}

/** Start of the current UTC month. */
export const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

function spent(ctx: Ctx, projectId: string | null, since: string): number {
  const r = (projectId
    ? ctx.db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS t FROM usage_events WHERE created_at>=? AND project_id=?").get(since, projectId)
    : ctx.db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS t FROM usage_events WHERE created_at>=?").get(since)) as { t: number };
  return r.t;
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** Throws BUDGET_EXCEEDED when the global or the current project's monthly cap is used up. */
export function checkBudget(ctx: Ctx) {
  const rows = ctx.db.prepare("SELECT scope, project_id, monthly_limit_usd FROM budgets").all() as { scope: string; project_id: string | null; monthly_limit_usd: number }[];
  if (!rows.length) return;
  const since = monthStart();
  const cur = scope.getStore()?.projectId ?? null;
  for (const b of rows) {
    if (b.project_id !== null && b.project_id !== cur) continue;
    const used = spent(ctx, b.project_id, since);
    if (used >= b.monthly_limit_usd) {
      throw new AppError("BUDGET_EXCEEDED", `${b.project_id ? "This project's" : "The"} monthly budget of ${money(b.monthly_limit_usd)} is used up (${money(used)} spent this month). Raise the limit on the Usage page to continue.`);
    }
  }
}

/** Wire the ledger into the DataForSEO client. Safe to call more than once. */
export function attachUsage(ctx: Ctx) {
  ctx.dfs.hooks = {
    beforeCall: () => checkBudget(ctx),
    onSpend: (path, costUsd) => recordSpend(ctx, { provider: "dataforseo", endpoint: path, costUsd }),
  };
}

// ---------------- budgets ----------------

export type Budget = { projectId: string | null; monthlyLimitUsd: number; spentUsd: number; percent: number; status: "ok" | "warning" | "exceeded" };

function budgetView(ctx: Ctx, row: { project_id: string | null; monthly_limit_usd: number }, since: string): Budget {
  const spentUsd = spent(ctx, row.project_id, since);
  const percent = (spentUsd / row.monthly_limit_usd) * 100;
  return { projectId: row.project_id, monthlyLimitUsd: row.monthly_limit_usd, spentUsd, percent, status: percent >= 100 ? "exceeded" : percent >= 80 ? "warning" : "ok" };
}

export function listBudgets(ctx: Ctx): Budget[] {
  const since = monthStart();
  return (ctx.db.prepare("SELECT project_id, monthly_limit_usd FROM budgets ORDER BY project_id IS NOT NULL, scope").all() as { project_id: string | null; monthly_limit_usd: number }[])
    .map((r) => budgetView(ctx, r, since));
}

export function getBudget(ctx: Ctx, projectId: string | null): Budget | null {
  const r = ctx.db.prepare("SELECT project_id, monthly_limit_usd FROM budgets WHERE scope=?").get(projectId ? `project:${projectId}` : "global") as { project_id: string | null; monthly_limit_usd: number } | undefined;
  return r ? budgetView(ctx, r, monthStart()) : null;
}

/** Set (or with `null` remove) a monthly cap, for one project or (projectId=null) for everything. */
export function setBudget(ctx: Ctx, projectId: string | null, monthlyLimitUsd: number | null) {
  if (projectId && !ctx.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new AppError("NOT_FOUND");
  const key = projectId ? `project:${projectId}` : "global";
  if (monthlyLimitUsd === null) { ctx.db.prepare("DELETE FROM budgets WHERE scope=?").run(key); return null; }
  if (typeof monthlyLimitUsd !== "number" || !Number.isFinite(monthlyLimitUsd) || monthlyLimitUsd <= 0 || monthlyLimitUsd > 1_000_000)
    throw new AppError("VALIDATION_ERROR", "The monthly limit must be a number above 0 (in USD).");
  const v = Math.round(monthlyLimitUsd * 10000) / 10000;
  if (v <= 0) throw new AppError("VALIDATION_ERROR", "The monthly limit must be at least $0.0001.");
  ctx.db.prepare("INSERT INTO budgets (scope,project_id,monthly_limit_usd,updated_at) VALUES (?,?,?,?) ON CONFLICT(scope) DO UPDATE SET monthly_limit_usd=excluded.monthly_limit_usd, updated_at=excluded.updated_at")
    .run(key, projectId, v, nowIso());
  return getBudget(ctx, projectId);
}

// ---------------- reporting ----------------

export type UsageSummary = {
  month: string;
  totalUsd: number;
  byProvider: { provider: string; usd: number }[];
  byFeature: { feature: string; label: string; usd: number; calls: number }[];
  byProject: { projectId: string | null; name: string; usd: number }[];
  daily: { day: string; usd: number }[];
  recent: { at: string; provider: string; feature: string; endpoint: string | null; usd: number; projectId: string | null }[];
  budgets: Budget[];
};

/** Spend for the current UTC month (or the last `days` days when given), optionally for one project. */
export function getUsage(ctx: Ctx, opts: { projectId?: string; days?: number } = {}): UsageSummary {
  const days = opts.days;
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 366)) throw new AppError("VALIDATION_ERROR", "days must be a whole number from 1 to 366");
  if (opts.projectId && !ctx.db.prepare("SELECT 1 FROM projects WHERE id=?").get(opts.projectId)) throw new AppError("NOT_FOUND");
  const since = days ? new Date(Date.now() - days * 86_400_000).toISOString() : monthStart();
  const where = `created_at>=?${opts.projectId ? " AND project_id=?" : ""}`;
  const args = opts.projectId ? [since, opts.projectId] : [since];
  const q = <T>(sql: string) => ctx.db.prepare(sql).all(...args) as T[];
  const byProvider = q<{ provider: string; usd: number }>(`SELECT provider, SUM(cost_usd) AS usd FROM usage_events WHERE ${where} GROUP BY provider ORDER BY usd DESC`);
  const byFeature = q<{ feature: string; usd: number; calls: number }>(`SELECT feature, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM usage_events WHERE ${where} GROUP BY feature ORDER BY usd DESC`)
    .map((f) => ({ ...f, label: FEATURES[f.feature] ?? f.feature }));
  const byProject = opts.projectId ? [] : (ctx.db.prepare(
    "SELECT e.project_id AS projectId, p.name AS name, SUM(e.cost_usd) AS usd FROM usage_events e LEFT JOIN projects p ON p.id=e.project_id WHERE e.created_at>=? GROUP BY e.project_id ORDER BY usd DESC",
  ).all(since) as { projectId: string | null; name: string | null; usd: number }[]).map((p) => ({ projectId: p.projectId, name: p.name ?? "Unassigned", usd: p.usd }));
  const daily = q<{ day: string; usd: number }>(`SELECT substr(created_at,1,10) AS day, SUM(cost_usd) AS usd FROM usage_events WHERE ${where} GROUP BY day ORDER BY day`);
  const recent = q<{ created_at: string; provider: string; feature: string; endpoint: string | null; cost_usd: number; project_id: string | null }>(
    `SELECT created_at, provider, feature, endpoint, cost_usd, project_id FROM usage_events WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT 50`)
    .map((r) => ({ at: r.created_at, provider: r.provider, feature: r.feature, endpoint: r.endpoint, usd: r.cost_usd, projectId: r.project_id }));
  const budgets = listBudgets(ctx).filter((b) => !opts.projectId || b.projectId === null || b.projectId === opts.projectId);
  return { month: since.slice(0, 7), totalUsd: byProvider.reduce((a, b) => a + b.usd, 0), byProvider, byFeature, byProject, daily, recent, budgets };
}
