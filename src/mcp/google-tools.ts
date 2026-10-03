import type { Ctx } from "../ctx.ts";
import { AppError } from "../errors.ts";
import { googleConfigured } from "../google/oauth.ts";
import {
  GSC_DEFAULT_ROW_LIMIT, GSC_MAX_ROW_LIMIT, GscNotConnectedError, describeGoogleError, getGscPerformance, inspectUrls, isGoogleReconnectError,
} from "../services/gsc.ts";
import {
  Ga4ReportError, OVERVIEW_METRICS, getMeasurementHealth, getOrganicOverview, getSearchOpportunities, runGa4Report, type ReportInput,
} from "../services/ga4.ts";
import { getProject } from "../services/projects.ts";
import type { ToolEnv, ToolResult } from "./tools.ts";

type Args = Record<string, any>;
type Handler = (ctx: Ctx, a: Args, env: ToolEnv) => Promise<ToolResult>;

const page = (env: ToolEnv, id: string, path: string) => `${env.baseUrl}/p/${id}${path}`;
const SETUP_DOCS = "docs/GOOGLE.md in the closeseo repository";

// ---------------------------------------------------------------- Search Console
const gscFailure = (env: ToolEnv, projectId: string, error: unknown): ToolResult => {
  const notConnected = error instanceof GscNotConnectedError;
  if (!notConnected && !isGoogleReconnectError(error) && !(error instanceof Error && "status" in error)) throw error;
  const connectUrl = page(env, projectId, "/search-performance");
  return {
    data: { ok: false, reason: notConnected ? "not_connected" : "api_error", connectUrl },
    text: `${describeGoogleError(error)}${notConnected ? ` Connect it here: ${connectUrl}` : ` (reconnect at ${connectUrl})`}`,
    url: page(env, projectId, "/settings/integrations"),
  };
};

const notConfigured = (env: ToolEnv, projectId: string): ToolResult => ({
  data: { ok: false, connected: false, reason: "gsc_oauth_not_configured", setupDocsUrl: SETUP_DOCS },
  text: `This closeseo server is not configured for Search Console yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and CLOSESEO_SECRET (32+ characters), then connect Search Console from the project's Integrations page. Setup: ${SETUP_DOCS}`,
  url: page(env, projectId, ""),
});

const matches = (r: { impressions: number; position?: number }, f: { minPosition?: number; maxPosition?: number; minImpressions?: number }) => {
  if (f.minImpressions !== undefined && r.impressions < f.minImpressions) return false;
  if (f.minPosition !== undefined && (r.position === undefined || r.position < f.minPosition)) return false;
  if (f.maxPosition !== undefined && (r.position === undefined || r.position > f.maxPosition)) return false;
  return true;
};
const round = <T extends { ctr: number; position?: number }>(r: T): T => ({ ...r, ctr: Math.round(r.ctr * 10_000) / 10_000, ...(r.position === undefined ? {} : { position: Math.round(r.position * 10) / 10 }) });

export const gscHandlers: Record<string, Handler> = {
  get_search_console_performance: async (ctx, a, env) => {
    getProject(ctx, a.projectId);
    if (!googleConfigured(ctx)) return notConfigured(env, a.projectId);
    const url = page(env, a.projectId, "/settings/integrations");
    const bad = (m: string): ToolResult => ({ data: { ok: false, reason: "invalid_request" }, text: m, url });
    if (a.dimensions?.includes("searchAppearance") && a.dimensions.length > 1) return bad("Use searchAppearance on its own; it cannot be combined with other dimensions.");
    if (Boolean(a.startDate) !== Boolean(a.endDate)) return bad("Give startDate and endDate together, or leave both out and use dateRange.");
    try {
      const requested = a.rowLimit ?? GSC_DEFAULT_ROW_LIMIT;
      const metricFilter = a.minPosition !== undefined || a.maxPosition !== undefined || a.minImpressions !== undefined ? { minPosition: a.minPosition, maxPosition: a.maxPosition, minImpressions: a.minImpressions } : null;
      // Google cannot filter on position or impressions, so with such a filter the whole window is fetched and filtered here.
      const fetchLimit = metricFilter ? GSC_MAX_ROW_LIMIT : requested;
      const r = await getGscPerformance(ctx, a.projectId, { ...a, rowLimit: fetchLimit });
      const dimensions = r.request.dimensions;
      const startRow = r.request.startRow ?? 0;
      const kept = metricFilter ? r.rows.filter((x) => matches(x, metricFilter)) : r.rows;
      const rows = kept.slice(0, requested).map(round);
      const last = kept[rows.length - 1];
      const truncated = kept.length > rows.length;
      const hasMore = truncated || r.rows.length >= fetchLimit;
      const nextStartRow = truncated && last ? startRow + r.rows.indexOf(last) + 1 : startRow + r.rows.length;
      const header = `${r.siteUrl} · ${dimensions.join("+")} · ${r.request.startDate}→${r.request.endDate} · ${rows.length} row${rows.length === 1 ? "" : "s"}${metricFilter ? ` · filtered ${r.rows.length} rows → ${kept.length}` : ""}${hasMore ? " (more available — paginate with startRow)" : ""}`;
      const table = rows.slice(0, 15).map((x) => `${x.keys?.join(" / ") ?? "(total)"} | ${x.clicks} clicks | ${x.impressions} impr | ${(x.ctr * 100).toFixed(1)}% | pos ${x.position?.toFixed(1) ?? "—"}`).join("\n");
      return { data: { ok: true, siteUrl: r.siteUrl, startDate: r.request.startDate, endDate: r.request.endDate, dimensions, rowCount: rows.length, rows, hasMore, nextStartRow: hasMore ? nextStartRow : undefined }, text: rows.length ? `${header}\n${table}` : `${header}\nSearch Console returned no rows for that query and date range.`, url };
    } catch (e) { return gscFailure(env, a.projectId, e); }
  },

  inspect_urls: async (ctx, a, env) => {
    getProject(ctx, a.projectId);
    if (!googleConfigured(ctx)) return notConfigured(env, a.projectId);
    try {
      const r = await inspectUrls(ctx, a.projectId, a as never);
      const lines = r.results.slice(0, 15).map((x) => {
        if (x.error) return `  ${x.url} — error: ${x.error}`;
        const ix = x.result?.indexStatusResult;
        return `  ${x.url} — ${ix?.verdict ?? "UNKNOWN"}: ${ix?.coverageState ?? "—"}${ix?.googleCanonical ? `, google-canonical ${ix.googleCanonical}` : ""}`;
      });
      return { data: { ok: true, siteUrl: r.siteUrl, results: r.results }, text: `${r.siteUrl} · inspected ${r.results.length} URL${r.results.length === 1 ? "" : "s"}\n${lines.join("\n")}`, url: page(env, a.projectId, "/settings/integrations") };
    } catch (e) { return gscFailure(env, a.projectId, e); }
  },
};

// ---------------------------------------------------------------- Analytics
function ga4Failure(env: ToolEnv, projectId: string, error: unknown): ToolResult {
  let code: string, message: string, retry: number | null | undefined;
  if (error instanceof Ga4ReportError) { code = error.code; message = error.message; retry = error.retryAfterSeconds; }
  else if (error instanceof GscNotConnectedError) { code = "gsc_not_connected"; message = "No Search Console site is linked to this project yet."; }
  else if (isGoogleReconnectError(error)) { code = "gsc_reconnect_required"; message = "Google no longer accepts the saved Search Console sign-in (it expired or was revoked). Connect again."; }
  else if (error instanceof Error && "status" in error) { code = "gsc_upstream_unavailable"; message = "Search Console could not be reached just now. Try again shortly."; }
  else throw error;
  const actionUrl = ["ga4_not_connected", "ga4_reconnect_required", "ga4_property_inaccessible"].includes(code) ? page(env, projectId, "/settings/integrations") : code.startsWith("gsc_") ? page(env, projectId, "/search-performance") : undefined;
  return { data: { status: "error", error: { code, message, retryAfterSeconds: retry, actionUrl } }, text: `${message}${actionUrl ? ` Continue here: ${actionUrl}` : ""}`, url: page(env, projectId, "") };
}

const endNote = (r: { warnings: string[]; request: { resolvedDateRange: { endDate: string } } }) => (r.warnings.includes("end_date_clamped") ? ` The end date was moved to the last complete day (${r.request.resolvedDateRange.endDate}).` : "");

function reportText(label: string, r: Awaited<ReturnType<typeof runGa4Report>>): string {
  const range = r.request.resolvedDateRange;
  const cmp = r.comparison ? ` Compared with ${r.comparison.previousDateRange.startDate} through ${r.comparison.previousDateRange.endDate}.` : "";
  const diag = r.diagnostics?.length ? ` Diagnostics: ${r.diagnostics.map((d: any) => d.code).join(", ")}.` : "";
  const limited = r.reportMetadata.hasLimitedData ? " Data may be sampled, thresholded or restricted." : "";
  const more = r.pageInfo.hasMore ? " More rows are available; call again with offset to page through them." : "";
  const head = `${label}: ${r.rowCount} of ${r.totalRowCount} rows for ${range.startDate} through ${range.endDate}.${endNote(r)}${cmp}${diag}${limited}${more}`;
  return r.rows.length === 0 ? head : `${head}\n${r.rows.slice(0, 25).map((x) => Object.values(x).join(" | ")).join("\n")}`;
}

function reportHandler(label: string, toInput: (a: Args) => Omit<ReportInput, "projectId">): Handler {
  return async (ctx, a, env) => {
    getProject(ctx, a.projectId);
    try {
      const r = await runGa4Report(ctx, a.projectId, { ...toInput(a), projectId: a.projectId });
      return { data: r as unknown as Record<string, unknown>, text: reportText(label, r), url: page(env, a.projectId, "/settings/integrations") };
    } catch (e) { return ga4Failure(env, a.projectId, e); }
  };
}
const common = (a: Args) => ({ startDate: a.startDate, endDate: a.endDate, limit: a.limit, offset: a.offset });

export const ga4Handlers: Record<string, Handler> = {
  get_google_analytics_organic_landing_pages: reportHandler("Organic landing pages", (a) => ({ ...common(a), kind: "landing_pages", channel: "organic_search" })),
  get_google_analytics_page_performance: reportHandler("Page performance", (a) => ({ ...common(a), kind: "page_performance", includeDate: a.includeDate, channel: a.channel })),
  get_google_analytics_key_events: reportHandler("Key events", (a) => ({ ...common(a), kind: "key_events", breakdown: a.breakdown, channel: a.channel, comparePreviousPeriod: a.comparePreviousPeriod })),
  get_google_analytics_traffic_acquisition: reportHandler("Traffic acquisition", (a) => ({ ...common(a), kind: "traffic_acquisition", channel: "all", acquisitionBreakdown: a.breakdown, comparePreviousPeriod: a.comparePreviousPeriod })),
  get_google_analytics_ecommerce_performance: reportHandler("Ecommerce performance", (a) => ({ ...common(a), kind: "ecommerce_performance", ecommerceBreakdown: a.breakdown, ecommerceOnlyWithTransactions: a.onlyWithTransactions, channel: a.channel })),
  get_google_analytics_site_search: reportHandler("Site search", (a) => ({ ...common(a), kind: "site_search", channel: "all" })),
  get_google_analytics_audience_breakdown: reportHandler("Audience breakdown", (a) => ({ ...common(a), kind: "audience_breakdown", audienceBreakdown: a.breakdown, channel: a.channel, comparePreviousPeriod: a.comparePreviousPeriod })),

  get_google_analytics_organic_overview: async (ctx, a, env) => {
    getProject(ctx, a.projectId);
    try {
      const r = await getOrganicOverview(ctx, a.projectId, a);
      const range = r.request.resolvedDateRange, prev = r.request.previousDateRange;
      const head = `Organic overview for ${range.startDate} through ${range.endDate}, compared with ${prev.startDate} through ${prev.endDate}.${endNote(r)}${r.warnings.includes("trend_truncated") ? ` The trend was cut at ${r.trend.length} rows; use trend=weekly or a shorter date range for the full series.` : ""}`;
      const text = !r.current ? `${head} There was no organic-search traffic in this period.` : `${head}\n${OVERVIEW_METRICS.map((m) => `${m}: ${r.current![m] ?? "—"} (previous ${r.previous?.[m] ?? "—"})`).join("\n")}`;
      return { data: r as unknown as Record<string, unknown>, text, url: page(env, a.projectId, "/settings/integrations") };
    } catch (e) { return ga4Failure(env, a.projectId, e); }
  },

  get_search_opportunities: async (ctx, a, env) => {
    getProject(ctx, a.projectId);
    try {
      const r = await getSearchOpportunities(ctx, a.projectId, a);
      return { data: r as unknown as Record<string, unknown>, text: `${r.rowCount} search opportunities selected out of ${r.totalCandidateRows} candidate queries; ${r.coverage.matchedRows} of the candidates could be tied to a GA4 landing page.`, url: page(env, a.projectId, "/search-performance") };
    } catch (e) { return ga4Failure(env, a.projectId, e); }
  },

  get_google_analytics_measurement_health: async (ctx, a, env) => {
    getProject(ctx, a.projectId);
    try {
      const r = await getMeasurementHealth(ctx, a.projectId);
      return { data: r as unknown as Record<string, unknown>, text: `Analytics setup check: ${r.summary.webStreamCount} web stream(s), ${r.summary.keyEventCount} key event(s), ${r.summary.issueCount} problem(s) flagged.`, url: page(env, a.projectId, "/settings/integrations") };
    } catch (e) { return ga4Failure(env, a.projectId, e); }
  },
};

export { AppError };
