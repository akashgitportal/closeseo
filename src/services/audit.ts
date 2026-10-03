import type { Ctx } from "../ctx.ts";
import { newId, nowIso, tx } from "../db.ts";
import { AppError } from "../errors.ts";
import { crawlSite, normalizeUrl } from "../audit/crawl.ts";
import { createFetcher, type Fetcher } from "../audit/fetcher.ts";
import { ISSUE_CATALOG } from "../audit/issues.ts";
import { assertCrawlableUrl } from "../audit/url-policy.ts";
import { getProject } from "./projects.ts";

const DEFAULT_MAX_PAGES = 50;
const HARD_MAX_PAGES = 10_000;

const running = new Map<string, { abort: AbortController; done: Promise<void> }>();
export async function awaitAudits() {
  while (running.size) await Promise.allSettled([...running.values()].map((r) => r.done));
}

type AuditRow = {
  id: string; project_id: string; start_url: string; status: string; max_pages: number;
  pages_crawled: number; error_message: string | null; started_at: string; completed_at: string | null;
};

function audit(ctx: Ctx, projectId: string, auditId: string): AuditRow {
  const r = ctx.db.prepare("SELECT * FROM audits WHERE id=? AND project_id=?").get(auditId, projectId) as AuditRow | undefined;
  if (!r) throw new AppError("NOT_FOUND", "NOT_FOUND");
  return r;
}

export function startAudit(
  ctx: Ctx, projectId: string,
  i: { url: string; maxPages?: number; renderJavaScript?: boolean; runLighthouse?: boolean },
  fetcher?: Fetcher,
) {
  getProject(ctx, projectId);
  if (i.renderJavaScript)
    throw new AppError("VALIDATION_ERROR", "Audits cannot render JavaScript in this version; start the audit without renderJavaScript");
  const target = assertCrawlableUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(i.url) ? i.url : `https://${i.url}`, ctx.config.allowPrivateAuditTargets);
  const startUrl = normalizeUrl(target.href)!;
  const maxPages = Math.min(HARD_MAX_PAGES, Math.max(1, i.maxPages ?? DEFAULT_MAX_PAGES));
  const id = newId();
  ctx.db.prepare("INSERT INTO audits (id,project_id,start_url,status,max_pages,started_at) VALUES (?,?,?,'running',?,?)").run(id, projectId, startUrl, maxPages, nowIso());
  const abort = new AbortController();
  const f = fetcher ?? createFetcher({ allowPrivate: ctx.config.allowPrivateAuditTargets });
  const done = runAudit(ctx, id, startUrl, maxPages, Boolean(i.runLighthouse), f, abort.signal).finally(() => running.delete(id));
  running.set(id, { abort, done });
  return { auditId: id };
}

async function runAudit(ctx: Ctx, id: string, startUrl: string, maxPages: number, lighthouse: boolean, fetcher: Fetcher, signal: AbortSignal) {
  try {
    const out = await crawlSite({
      startUrl, maxPages, fetcher, signal,
      onPage: (_p, n) => { ctx.db.prepare("UPDATE audits SET pages_crawled=? WHERE id=?").run(n, id); },
    });
    if (signal.aborted) return; // cancelled: status already set by cancelAudit
    tx(ctx.db, () => {
      for (const p of out.pages) {
        const pageId = newId();
        ctx.db.prepare(
          `INSERT INTO audit_pages (id,audit_id,url,status_code,fetch_class,title,meta_description,h1_count,word_count,canonical,noindex,response_ms,depth)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(pageId, id, p.url, p.statusCode, p.fetchClass, p.title, p.metaDescription, p.h1Count, p.wordCount, p.canonical, p.noindex ? 1 : 0, p.responseMs, p.depth);
        for (const iss of p.issues)
          ctx.db.prepare("INSERT INTO audit_issues (id,audit_id,page_id,url,type,severity,detail) VALUES (?,?,?,?,?,?,?)").run(newId(), id, pageId, p.url, iss.type, iss.severity, iss.detail ?? null);
      }
      for (const s of out.siteLevel)
        ctx.db.prepare("INSERT INTO audit_issues (id,audit_id,page_id,url,type,severity,detail) VALUES (?,?,NULL,?,?,?,?)").run(newId(), id, s.url, s.issue.type, s.issue.severity, s.issue.detail ?? null);
    });
    if (lighthouse) await runLighthouse(ctx, id, startUrl);
    ctx.db.prepare("UPDATE audits SET status='completed', pages_crawled=?, completed_at=? WHERE id=? AND status='running'").run(out.pages.length, nowIso(), id);
  } catch (e) {
    ctx.db.prepare("UPDATE audits SET status='failed', error_message=?, completed_at=? WHERE id=? AND status='running'").run((e as Error).message, nowIso(), id);
  }
}

async function runLighthouse(ctx: Ctx, id: string, url: string) {
  let value: unknown;
  try {
    const r = await ctx.dfs.first<{ categories?: Record<string, { score?: number | null }> }>(
      "/v3/on_page/lighthouse/live/json",
      { url, for_mobile: true, categories: ["performance", "accessibility", "best_practices", "seo"] },
    );
    const cats = r.result?.categories ?? {};
    value = { url, scores: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, v?.score ?? null])) };
  } catch (e) {
    value = { url, error: (e as Error).message };
  }
  ctx.db.prepare("INSERT OR REPLACE INTO kv_cache (key,value,expires_at) VALUES (?,?,?)").run(`audit-lighthouse:${id}`, JSON.stringify(value), Number.MAX_SAFE_INTEGER);
}

export function cancelAudit(ctx: Ctx, projectId: string, auditId: string) {
  const a = audit(ctx, projectId, auditId);
  if (a.status !== "running") return { auditId, cancelled: false };
  ctx.db.prepare("UPDATE audits SET status='cancelled', completed_at=? WHERE id=? AND status='running'").run(nowIso(), auditId);
  running.get(auditId)?.abort.abort();
  return { auditId, cancelled: true };
}

export function failInterruptedAudits(ctx: Ctx): number {
  return Number(ctx.db.prepare("UPDATE audits SET status='failed', error_message='Interrupted by a server restart', completed_at=? WHERE status='running'").run(nowIso()).changes);
}

function counts(ctx: Ctx, id: string) {
  const rows = ctx.db.prepare("SELECT severity, COUNT(*) AS n FROM audit_issues WHERE audit_id=? GROUP BY severity").all(id) as { severity: string; n: number }[];
  const c = { critical: 0, warning: 0, info: 0 };
  for (const r of rows) c[r.severity as keyof typeof c] = Number(r.n);
  return c;
}

function present(ctx: Ctx, a: AuditRow) {
  const lh = ctx.db.prepare("SELECT value FROM kv_cache WHERE key=?").get(`audit-lighthouse:${a.id}`) as { value: string } | undefined;
  return {
    id: a.id, projectId: a.project_id, startUrl: a.start_url, status: a.status, maxPages: a.max_pages,
    pagesCrawled: a.pages_crawled, errorMessage: a.error_message, startedAt: a.started_at, completedAt: a.completed_at,
    issueCounts: counts(ctx, a.id), ...(lh ? { lighthouse: JSON.parse(lh.value) as unknown } : {}),
  };
}

export function listAudits(ctx: Ctx, projectId: string) {
  getProject(ctx, projectId);
  const rows = ctx.db.prepare("SELECT * FROM audits WHERE project_id=? ORDER BY started_at DESC, rowid DESC").all(projectId) as AuditRow[];
  return { audits: rows.map((a) => present(ctx, a)) };
}

export function getAuditStatus(ctx: Ctx, projectId: string, auditId?: string) {
  getProject(ctx, projectId);
  const a = auditId
    ? audit(ctx, projectId, auditId)
    : (ctx.db.prepare("SELECT * FROM audits WHERE project_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(projectId) as AuditRow | undefined);
  if (!a) throw new AppError("NOT_FOUND", "This project has no audits yet; begin one with run_site_audit");
  return { status: present(ctx, a) };
}

export function deleteAudit(ctx: Ctx, projectId: string, auditId: string) {
  const a = audit(ctx, projectId, auditId);
  if (a.status === "running") cancelAudit(ctx, projectId, auditId);
  ctx.db.prepare("DELETE FROM kv_cache WHERE key=?").run(`audit-lighthouse:${auditId}`);
  ctx.db.prepare("DELETE FROM audits WHERE id=?").run(auditId);
  return { auditId, deleted: true as const };
}

function resolveAuditId(ctx: Ctx, projectId: string, auditId?: string): string {
  getProject(ctx, projectId);
  if (auditId) return audit(ctx, projectId, auditId).id;
  const r = ctx.db.prepare("SELECT id FROM audits WHERE project_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(projectId) as { id: string } | undefined;
  if (!r) throw new AppError("NOT_FOUND", "This project has no audits yet; begin one with run_site_audit");
  return r.id;
}

export function getAuditIssues(ctx: Ctx, projectId: string, i: { auditId?: string; severity?: string; issueType?: string; limit?: number }) {
  const id = resolveAuditId(ctx, projectId, i.auditId);
  const where = ["audit_id=?"]; const args: (string | number)[] = [id];
  if (i.severity) { where.push("severity=?"); args.push(i.severity); }
  if (i.issueType) { where.push("type=?"); args.push(i.issueType); }
  const w = where.join(" AND ");
  const summary = (ctx.db.prepare(`SELECT type, severity, COUNT(*) AS count FROM audit_issues WHERE ${w} GROUP BY type, severity ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, count DESC, type`).all(...args) as { type: string; severity: string; count: number }[])
    .map((s) => ({ type: s.type, severity: s.severity, count: Number(s.count), title: ISSUE_CATALOG[s.type]?.title ?? s.type }));
  const issues = (ctx.db.prepare(`SELECT id, type, severity, url, detail FROM audit_issues WHERE ${w} ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, type, url LIMIT ?`).all(...args, Math.min(1000, Math.max(1, i.limit ?? 100))) as Record<string, unknown>[]);
  return { summary, issues };
}

export function getAuditPages(ctx: Ctx, projectId: string, i: { auditId?: string; fetchClass?: string; statusCode?: number; urlContains?: string; limit?: number }) {
  const id = resolveAuditId(ctx, projectId, i.auditId);
  const where = ["audit_id=?"]; const args: (string | number)[] = [id];
  if (i.fetchClass) { where.push("fetch_class=?"); args.push(i.fetchClass); }
  if (i.statusCode !== undefined) { where.push("status_code=?"); args.push(i.statusCode); }
  if (i.urlContains) { where.push("url LIKE ? ESCAPE '\\'"); args.push(`%${i.urlContains.replace(/[\\%_]/g, "\\$&")}%`); }
  const w = where.join(" AND ");
  const total = Number((ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_pages WHERE ${w}`).get(...args) as { n: number }).n);
  const rows = ctx.db.prepare(`SELECT id, url, status_code, fetch_class, title, meta_description, h1_count, word_count, canonical, noindex, response_ms, depth FROM audit_pages WHERE ${w} ORDER BY depth, url LIMIT ?`).all(...args, Math.min(1000, Math.max(1, i.limit ?? 100))) as Record<string, unknown>[];
  return {
    pages: rows.map((r) => ({
      id: r.id, url: r.url, statusCode: r.status_code, fetchClass: r.fetch_class, title: r.title,
      metaDescription: r.meta_description, h1Count: r.h1_count, wordCount: r.word_count, canonical: r.canonical,
      noindex: Boolean(r.noindex), responseMs: r.response_ms, depth: r.depth,
    })),
    total,
  };
}
