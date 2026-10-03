import type { Ctx } from "../ctx.ts";
import { nowIso } from "../db.ts";
import { AppError } from "../errors.ts";
import { GoogleApiError, GoogleTokenError, apiBase, googleJson, grantsFor } from "../google/oauth.ts";
import { getProject } from "./projects.ts";

export const GSC_DIMENSIONS = ["query", "page", "country", "device", "date", "searchAppearance"] as const;
export const GSC_DEFAULT_ROW_LIMIT = 250;
export const GSC_MAX_ROW_LIMIT = 1000;
const GSC_DATA_LAG_DAYS = 3; // Search Console data trails by 2-3 days

export class GscNotConnectedError extends Error { constructor() { super("Search Console is not connected for this project"); this.name = "GscNotConnectedError"; } }

type Row = { keys?: string[]; clicks: number; impressions: number; ctr: number; position?: number };
export type GscSite = { siteUrl: string; permissionLevel: string };

const fmt = (d: Date) => d.toISOString().slice(0, 10);
function subMonths(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const d = new Date(date);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d;
}

/** Resolve a convenience window or explicit dates, clamping the start to Search Console's 16-month history. */
export function resolveDateRange(i: { dateRange?: string; startDate?: string; endDate?: string }, today = new Date()) {
  const floor = fmt(subMonths(today, 16));
  if (i.startDate && i.endDate) return { startDate: i.startDate < floor ? floor : i.startDate, endDate: i.endDate };
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() - GSC_DATA_LAG_DAYS);
  const range = i.dateRange ?? "last_28_days";
  const start = new Date(end);
  if (range === "last_7_days") start.setUTCDate(start.getUTCDate() - 7);
  else if (range === "last_28_days") start.setUTCDate(start.getUTCDate() - 28);
  else return { startDate: (s => (s < floor ? floor : s))(fmt(subMonths(end, ({ last_3_months: 3, last_6_months: 6, last_12_months: 12, last_16_months: 16 } as Record<string, number>)[range] ?? 3))), endDate: fmt(end) };
  const s = fmt(start);
  return { startDate: s < floor ? floor : s, endDate: fmt(end) };
}

type PerfInput = {
  dimensions?: string[]; dateRange?: string; startDate?: string; endDate?: string;
  filters?: { dimension: string; operator?: string; expression: string }[]; rowLimit?: number; startRow?: number; type?: string; dataState?: string;
};

/** `searchAnalytics.query` body. Flat filters must be wrapped in dimensionFilterGroups: Google silently ignores a top-level `filters`. */
export function buildSearchAnalyticsRequest(i: PerfInput, today = new Date()) {
  const { startDate, endDate } = resolveDateRange(i, today);
  const req: Record<string, unknown> = {
    startDate, endDate, dimensions: i.dimensions?.length ? i.dimensions : ["query"],
    rowLimit: Math.min(Math.max(i.rowLimit ?? GSC_DEFAULT_ROW_LIMIT, 1), GSC_MAX_ROW_LIMIT), type: i.type ?? "web", dataState: i.dataState ?? "all",
  };
  if (i.startRow && i.startRow > 0) req.startRow = i.startRow;
  if (i.filters?.length) req.dimensionFilterGroups = [{ groupType: "and", filters: i.filters.map((f) => ({ ...f, operator: f.operator ?? "equals" })) }];
  return req as { startDate: string; endDate: string; dimensions: string[]; rowLimit: number; startRow?: number; type: string; dataState: string };
}

type Conn = { project_id: string; site_url: string; grant_id: string; connected_email: string | null };
export const getGscConnection = (ctx: Ctx, projectId: string) => ctx.db.prepare("SELECT * FROM gsc_connections WHERE project_id=?").get(projectId) as Conn | undefined;
const sites = (ctx: Ctx, grantId: string) => googleJson<{ siteEntry?: GscSite[] }>(ctx, grantId, `${apiBase(ctx, "www.googleapis.com")}/webmasters/v3/sites`).then((r) => r.siteEntry ?? []);

export function describeGoogleError(e: unknown): string {
  if (e instanceof GscNotConnectedError) return "Search Console is not connected for this project.";
  if (e instanceof GoogleTokenError) return "The Search Console connection has expired or was revoked. Reconnect it to continue.";
  if (e instanceof GoogleApiError) {
    if (e.status === 401 || e.status === 403) return "Search Console denied access to this property (no verified permission, or the connection was revoked).";
    if (e.status === 429) return "Search Console rate limit reached. Retry shortly.";
    if (e.status === 404) return "Search Console property not found. It may have been removed in Search Console.";
    return `Search Console API error (${e.status}): ${e.body.slice(0, 300)}`;
  }
  return e instanceof Error ? e.message : String(e);
}
export const isGoogleReconnectError = (e: unknown) => e instanceof GoogleTokenError || (e instanceof GoogleApiError && (e.status === 401 || e.status === 403));

export async function listGscSites(ctx: Ctx) {
  const accounts = await Promise.all(grantsFor(ctx, "gsc").map(async (g) => {
    try { return { grantId: g.id, email: g.email, requiresReconnect: false, propertiesUnavailable: false, sites: await sites(ctx, g.id) }; }
    catch (e) { return { grantId: g.id, email: g.email, requiresReconnect: isGoogleReconnectError(e), propertiesUnavailable: !isGoogleReconnectError(e), sites: [] as GscSite[] }; }
  }));
  return { accounts };
}

export async function setGscSite(ctx: Ctx, projectId: string, i: { grantId: string; siteUrl: string }) {
  getProject(ctx, projectId);
  const grant = ctx.db.prepare("SELECT id, email FROM google_grants WHERE id=? AND provider='gsc'").get(i.grantId) as { id: string; email: string | null } | undefined;
  if (!grant) throw new AppError("NOT_FOUND", "That Google account isn't connected.");
  const match = (await sites(ctx, grant.id)).find((s) => s.siteUrl === i.siteUrl);
  if (!match) throw new AppError("NOT_FOUND", "That Search Console property isn't available on your connected Google account.");
  if (match.permissionLevel === "siteUnverifiedUser") throw new AppError("VALIDATION_ERROR", "You don't have verified access to that Search Console property.");
  ctx.db.prepare("INSERT INTO gsc_connections (project_id,site_url,grant_id,connected_email,created_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET site_url=excluded.site_url, grant_id=excluded.grant_id, connected_email=excluded.connected_email")
    .run(projectId, i.siteUrl, grant.id, grant.email, nowIso());
  return getGscConnection(ctx, projectId)!;
}

export function disconnectGsc(ctx: Ctx, projectId: string) { ctx.db.prepare("DELETE FROM gsc_connections WHERE project_id=?").run(projectId); }

export async function getGscPerformance(ctx: Ctx, projectId: string, input: PerfInput) {
  const c = getGscConnection(ctx, projectId);
  if (!c) throw new GscNotConnectedError();
  const request = buildSearchAnalyticsRequest(input);
  const r = await googleJson<{ rows?: Row[] }>(ctx, c.grant_id, `${apiBase(ctx, "www.googleapis.com")}/webmasters/v3/sites/${encodeURIComponent(c.site_url)}/searchAnalytics/query`, { method: "POST", body: request });
  return { siteUrl: c.site_url, connectedBy: c.connected_email, request, rows: (r.rows ?? []) as Required<Row>[] };
}

export type UrlInspectionResult = Record<string, any>;

/** Inspect up to 10 URLs against the connected property; a bad URL is reported inline and does not fail the batch. */
export async function inspectUrls(ctx: Ctx, projectId: string, i: { urls: string[]; languageCode?: string }) {
  const c = getGscConnection(ctx, projectId);
  if (!c) throw new GscNotConnectedError();
  const results: { url: string; result: UrlInspectionResult | null; error?: string }[] = [];
  for (const url of i.urls) {
    try {
      const r = await googleJson<{ inspectionResult?: UrlInspectionResult }>(ctx, c.grant_id, `${apiBase(ctx, "searchconsole.googleapis.com")}/v1/urlInspection/index:inspect`, {
        method: "POST", body: { inspectionUrl: url, siteUrl: c.site_url, ...(i.languageCode ? { languageCode: i.languageCode } : {}) },
      });
      results.push({ url, result: r.inspectionResult ?? null });
    } catch (e) {
      if (e instanceof GoogleTokenError) throw e;
      results.push({ url, result: null, error: describeGoogleError(e) });
    }
  }
  return { siteUrl: c.site_url, connectedBy: c.connected_email, results };
}

export { nowIso };
