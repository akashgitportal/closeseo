import type { Ctx } from "../ctx.ts";
import { nowIso } from "../db.ts";
import { AppError } from "../errors.ts";
import { getProject } from "./projects.ts";
import { getRankTracker } from "./rankTracking.ts";
import { getBudget, monthStart } from "./usage.ts";

/**
 * Project dashboard. Everything here is read from closeseo's own database, so opening it never costs money
 * (the original refreshes a backlink snapshot from the provider on view; closeseo leaves that to the Backlinks tab).
 */

export const STEPS = ["domain", "keywords", "competitors", "rankings", "audit", "ai", "gsc", "ga4", "budget"] as const;
export type StepKey = (typeof STEPS)[number];

const count = (ctx: Ctx, sql: string, ...args: string[]) => (ctx.db.prepare(sql).get(...args) as { n: number }).n;

type Step = { key: StepKey; title: string; description: string; tab: string; done: boolean; dismissed: boolean };

export function getDashboard(ctx: Ctx, projectId: string) {
  const project = getProject(ctx, projectId);
  const n = (table: string) => count(ctx, `SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`, projectId);
  const savedKeywords = n("saved_keywords");
  const competitors = n("context_competitors");
  const aiRuns = n("ai_runs");
  const reports = n("reports");
  const gsc = ctx.db.prepare("SELECT site_url FROM gsc_connections WHERE project_id=?").get(projectId) as { site_url: string } | undefined;
  const ga4 = ctx.db.prepare("SELECT property_display_name FROM ga4_connections WHERE project_id=?").get(projectId) as { property_display_name: string } | undefined;
  const projectBudget = getBudget(ctx, projectId);
  const globalBudget = getBudget(ctx, null);

  // rank tracking
  const configs = (getRankTracker(ctx, projectId) as { configs: { id: string; domain: string }[] }).configs;
  let tracked = 0, top3 = 0, top10 = 0, ranking = 0, improved = 0, declined = 0, posSum = 0, lastChecked: string | null = null;
  for (const c of configs) {
    const t = getRankTracker(ctx, projectId, c.id) as { results: { rows: Record<"desktop" | "mobile", { position: number | null; previousPosition: number | null }>[]; run: { lastCheckedAt: string | null } | null } };
    for (const row of t.results.rows) {
      tracked++;
      // a tracker may follow one device or both; desktop is the headline when it has data
      const { position: p, previousPosition: prev } = row.desktop.position != null ? row.desktop : row.mobile;
      if (p == null) continue;
      ranking++; posSum += p;
      if (p <= 3) top3++;
      if (p <= 10) top10++;
      if (prev != null && p < prev) improved++;
      if (prev != null && p > prev) declined++;
    }
    const lc = t.results.run?.lastCheckedAt ?? null;
    if (lc && (!lastChecked || lc > lastChecked)) lastChecked = lc;
  }
  const rankings = { trackers: configs.length, trackedKeywords: tracked, ranking, top3, top10, improved, declined, averagePosition: ranking ? Math.round((posSum / ranking) * 10) / 10 : null, lastCheckedAt: lastChecked };

  // latest audit
  const a = ctx.db.prepare("SELECT id, status, pages_crawled, start_url, started_at, completed_at FROM audits WHERE project_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(projectId) as
    { id: string; status: string; pages_crawled: number; start_url: string; started_at: string; completed_at: string | null } | undefined;
  const audit = a ? {
    id: a.id, status: a.status, pagesCrawled: a.pages_crawled, startUrl: a.start_url, startedAt: a.started_at, completedAt: a.completed_at,
    bySeverity: Object.fromEntries((ctx.db.prepare("SELECT severity, COUNT(*) AS c FROM audit_issues WHERE audit_id=? GROUP BY severity").all(a.id) as { severity: string; c: number }[]).map((r) => [r.severity, r.c])) as Record<string, number>,
    topIssues: (ctx.db.prepare("SELECT type, severity, COUNT(DISTINCT url) AS pages FROM audit_issues WHERE audit_id=? GROUP BY type, severity ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, pages DESC, type LIMIT 5").all(a.id) as { type: string; severity: string; pages: number }[]),
  } : null;

  // latest AI visibility brand lookup
  const b = ctx.db.prepare("SELECT payload, created_at FROM ai_runs WHERE project_id=? AND kind='brand' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(projectId) as { payload: string; created_at: string } | undefined;
  let ai: { runs: number; lastBrand: { query: string; totalMentions: number | null; totalAiSearchVolume: number | null; sharePct: number | null; at: string } | null } = { runs: aiRuns, lastBrand: null };
  if (b) {
    try {
      const r = JSON.parse(b.payload) as { query: string; totalMentions: number | null; totalAiSearchVolume: number | null; shareOfVoice: { entries: { isTarget: boolean; sharePct: number | null }[] } | null };
      ai = { runs: aiRuns, lastBrand: { query: r.query, totalMentions: r.totalMentions, totalAiSearchVolume: r.totalAiSearchVolume, sharePct: r.shareOfVoice?.entries.find((e) => e.isTarget)?.sharePct ?? null, at: b.created_at } };
    } catch { /* a damaged history row only hides this card */ }
  }

  const since = monthStart();
  const spendRow = ctx.db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS t FROM usage_events WHERE project_id=? AND created_at>=?").get(projectId, since) as { t: number };
  const spend = { monthUsd: spendRow.t, budget: projectBudget ?? null, globalBudget: globalBudget ?? null };

  const done: Record<StepKey, boolean> = {
    domain: project.domain !== null, keywords: savedKeywords > 0, competitors: competitors > 0, rankings: tracked > 0, audit: a !== undefined,
    ai: aiRuns > 0, gsc: gsc !== undefined, ga4: ga4 !== undefined, budget: projectBudget !== null || globalBudget !== null,
  };
  const dismissed = new Set((ctx.db.prepare("SELECT step FROM dismissed_steps WHERE project_id=?").all(projectId) as { step: string }[]).map((r) => r.step));
  const text: Record<StepKey, [string, string, string]> = {
    domain: ["Add your website", "Set the project's domain so research can compare against your own site.", "settings"],
    keywords: ["Save your first keywords", "Research keywords and save the ones worth targeting.", "keywords"],
    competitors: ["Add competitors", "Record the sites you compete with; the assistant and reports use them.", "context"],
    rankings: ["Track rankings", "Pick keywords to follow and check where your domain ranks.", "rank-tracking"],
    audit: ["Run a site audit", "Crawl your site and list technical problems.", "audit"],
    ai: ["Check your AI visibility", "See whether ChatGPT, Claude, Gemini and Perplexity mention or cite you.", "ai"],
    gsc: ["Connect Search Console", "Bring real clicks and impressions into reports.", "integrations"],
    ga4: ["Connect Analytics", "Bring sessions and conversions into reports.", "integrations"],
    budget: ["Set a spend limit", "Cap what DataForSEO and OpenRouter can cost you each month.", "usage"],
  };
  const steps: Step[] = STEPS.map((key) => ({ key, title: text[key][0], description: text[key][1], tab: text[key][2], done: done[key], dismissed: !done[key] && dismissed.has(key) }));
  const open = steps.filter((s) => !s.done && !s.dismissed).length;

  return {
    project,
    counts: { savedKeywords, competitors, reports, aiRuns, assistantChats: n("agent_sessions") },
    steps, openSteps: open,
    gsc: gsc ? { siteUrl: gsc.site_url } : null, ga4: ga4 ? { property: ga4.property_display_name } : null,
    rankings, audit, ai, spend,
  };
}

export function dismissStep(ctx: Ctx, projectId: string, step: string, dismissed: boolean) {
  getProject(ctx, projectId);
  if (!(STEPS as readonly string[]).includes(step)) throw new AppError("VALIDATION_ERROR", `Unknown step. Use one of: ${STEPS.join(", ")}`);
  if (dismissed) ctx.db.prepare("INSERT OR IGNORE INTO dismissed_steps (project_id,step,created_at) VALUES (?,?,?)").run(projectId, step, nowIso());
  else ctx.db.prepare("DELETE FROM dismissed_steps WHERE project_id=? AND step=?").run(projectId, step);
}
