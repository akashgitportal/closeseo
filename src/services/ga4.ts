import type { Ctx } from "../ctx.ts";
import { nowIso } from "../db.ts";
import { AppError } from "../errors.ts";
import { GoogleApiError, GoogleTokenError, apiBase, googleJson, grantsFor } from "../google/oauth.ts";
import { getProject } from "./projects.ts";
import { getGscConnection, getGscPerformance, GscNotConnectedError } from "./gsc.ts";

export class Ga4ReportError extends Error {
  code: string; retryAfterSeconds: number | null;
  constructor(code: string, message: string, retryAfterSeconds: number | null = null) { super(message); this.name = "Ga4ReportError"; this.code = code; this.retryAfterSeconds = retryAfterSeconds; }
}
class MalformedResponse extends Error {}

type Conn = { project_id: string; property_id: string; property_display_name: string; property_time_zone: string; property_currency_code: string | null; grant_id: string; connected_email: string | null };
export const getGa4Connection = (ctx: Ctx, projectId: string) => ctx.db.prepare("SELECT * FROM ga4_connections WHERE project_id=?").get(projectId) as Conn | undefined;
const needConnection = (ctx: Ctx, projectId: string) => {
  const c = getGa4Connection(ctx, projectId);
  if (!c) throw new Ga4ReportError("ga4_not_connected", "No Google Analytics property is linked to this project.");
  return c;
};

// ---------------------------------------------------------------- Admin API: listing properties and checking access
const admin = (ctx: Ctx) => `${apiBase(ctx, "analyticsadmin.googleapis.com")}/v1beta`;
const adminAlpha = (ctx: Ctx) => `${apiBase(ctx, "analyticsadmin.googleapis.com")}/v1alpha`;
const PROP = /^properties\/\d+$/;
const propUrl = (ctx: Ctx, base: string, id: string, child: string) => {
  if (!PROP.test(id)) throw new AppError("VALIDATION_ERROR", "That is not a valid Google Analytics property id");
  const u = new URL(`${base}/${id}/${child}`);
  u.searchParams.set("pageSize", "200");
  return u.toString();
};

export async function listGa4Properties(ctx: Ctx) {
  const accounts = await Promise.all(grantsFor(ctx, "ga4").map(async (g) => {
    try {
      const properties: { propertyId: string; displayName: string; accountDisplayName: string }[] = [];
      let token: string | undefined;
      for (let page = 0; page < 100; page++) {
        const u = new URL(`${admin(ctx)}/accountSummaries`);
        u.searchParams.set("pageSize", "200");
        if (token) u.searchParams.set("pageToken", token);
        const r = await googleJson<{ accountSummaries?: { displayName: string; propertySummaries?: { property: string; displayName: string }[] }[]; nextPageToken?: string }>(ctx, g.id, u.toString());
        for (const a of r.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) properties.push({ propertyId: p.property, displayName: p.displayName, accountDisplayName: a.displayName });
        token = r.nextPageToken || undefined;
        if (!token) break;
      }
      return { grantId: g.id, email: g.email, requiresReconnect: false, propertiesUnavailable: false, properties };
    } catch (e) {
      const reconnect = e instanceof GoogleTokenError || (e instanceof GoogleApiError && e.status === 401);
      return { grantId: g.id, email: g.email, requiresReconnect: reconnect, propertiesUnavailable: !reconnect, properties: [] as { propertyId: string; displayName: string; accountDisplayName: string }[] };
    }
  }));
  return { accounts };
}

export async function setGa4Property(ctx: Ctx, projectId: string, i: { grantId: string; propertyId: string }) {
  getProject(ctx, projectId);
  const grant = ctx.db.prepare("SELECT id, email FROM google_grants WHERE id=? AND provider='ga4'").get(i.grantId) as { id: string; email: string | null } | undefined;
  if (!grant) throw new AppError("NOT_FOUND", "That Google account is not linked.");
  const listed = (await listGa4Properties(ctx)).accounts.find((a) => a.grantId === grant.id)?.properties ?? [];
  if (!listed.some((p) => p.propertyId === i.propertyId)) throw new AppError("NOT_FOUND", "The linked Google account has no access to that Analytics property.");
  if (!PROP.test(i.propertyId)) throw new AppError("VALIDATION_ERROR", "That is not a valid Google Analytics property id");
  const p = await googleJson<{ name: string; displayName: string; timeZone: string; currencyCode?: string }>(ctx, grant.id, `${admin(ctx)}/${i.propertyId}`);
  ctx.db.prepare(`INSERT INTO ga4_connections (project_id,property_id,property_display_name,property_time_zone,property_currency_code,grant_id,connected_email,created_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET property_id=excluded.property_id, property_display_name=excluded.property_display_name, property_time_zone=excluded.property_time_zone, property_currency_code=excluded.property_currency_code, grant_id=excluded.grant_id, connected_email=excluded.connected_email`)
    .run(projectId, p.name, p.displayName, p.timeZone, p.currencyCode ?? null, grant.id, grant.email, nowIso());
  return getGa4Connection(ctx, projectId)!;
}
export function disconnectGa4(ctx: Ctx, projectId: string) { ctx.db.prepare("DELETE FROM ga4_connections WHERE project_id=?").run(projectId); }

export function mapGa4Error(e: unknown): never {
  if (e instanceof Ga4ReportError) throw e;
  if (e instanceof GoogleTokenError) throw new Ga4ReportError("ga4_reconnect_required", "The Google Analytics link has lapsed or was withdrawn.");
  if (e instanceof MalformedResponse) throw new Ga4ReportError("ga4_malformed_response", "Google Analytics sent back a report that could not be read.");
  if (e instanceof GoogleApiError) {
    if (e.status === 400) throw new Ga4ReportError("ga4_report_incompatible", "The chosen Analytics property cannot produce this report.");
    if (e.status === 401) throw new Ga4ReportError("ga4_reconnect_required", "The Google Analytics link has lapsed or was withdrawn.");
    if (e.status === 403) {
      if (/SERVICE_DISABLED/.test(e.body)) throw new Ga4ReportError("ga4_upstream_unavailable", "The Google Analytics Data API is switched off for this OAuth application.");
      throw new Ga4ReportError("ga4_property_inaccessible", "The linked Google account has lost access to this property.");
    }
    if (e.status === 404) throw new Ga4ReportError("ga4_property_inaccessible", "The chosen Google Analytics property has gone away.");
    if (e.status === 429) throw new Ga4ReportError("ga4_quota_exhausted", "The Google Analytics reporting quota has run out; try later.", e.retryAfterSeconds);
    throw new Ga4ReportError("ga4_upstream_unavailable", "Google Analytics reporting is down for the moment.");
  }
  throw e;
}

export async function getMeasurementHealth(ctx: Ctx, projectId: string) {
  const c = needConnection(ctx, projectId);
  try {
    const J = <T,>(url: string) => googleJson<T>(ctx, c.grant_id, url);
    const streams = (await J<{ dataStreams?: any[] }>(propUrl(ctx, admin(ctx), c.property_id, "dataStreams"))).dataStreams ?? [];
    const webStreams = [];
    for (const s of streams) {
      if (s.type !== "WEB_DATA_STREAM") continue;
      const em = await J<Record<string, any>>(`${adminAlpha(ctx)}/${s.name}/enhancedMeasurementSettings`);
      webStreams.push({
        streamId: String(s.name).split("/").at(-1) ?? s.name, displayName: s.displayName, measurementId: s.webStreamData?.measurementId ?? null,
        defaultUri: s.webStreamData?.defaultUri ?? null, createTime: s.createTime ?? null, updateTime: s.updateTime ?? null, enhancedMeasurement: em,
      });
    }
    const [keyEvents, dims, metrics] = await Promise.all([
      J<{ keyEvents?: any[] }>(propUrl(ctx, admin(ctx), c.property_id, "keyEvents")).then((r) => r.keyEvents ?? []),
      J<{ customDimensions?: any[] }>(propUrl(ctx, admin(ctx), c.property_id, "customDimensions")).then((r) => r.customDimensions ?? []),
      J<{ customMetrics?: any[] }>(propUrl(ctx, admin(ctx), c.property_id, "customMetrics")).then((r) => r.customMetrics ?? []),
    ]);
    const issues: string[] = [];
    if (webStreams.length === 0) issues.push("no_web_stream");
    if (webStreams.length > 0 && webStreams.every((s) => !s.enhancedMeasurement.streamEnabled)) issues.push("enhanced_measurement_disabled");
    if (webStreams.length > 0 && webStreams.every((s) => !s.enhancedMeasurement.streamEnabled || !s.enhancedMeasurement.siteSearchEnabled)) issues.push("site_search_measurement_disabled");
    if (keyEvents.length === 0) issues.push("no_key_events_configured");
    return {
      status: "ok" as const,
      source: { provider: "google_analytics_admin" as const, propertyId: c.property_id, propertyDisplayName: c.property_display_name },
      summary: { dataStreamCount: streams.length, webStreamCount: webStreams.length, keyEventCount: keyEvents.length, customDimensionCount: dims.length, customMetricCount: metrics.length, issueCount: issues.length },
      issues, webStreams,
      otherStreams: streams.filter((s) => s.type !== "WEB_DATA_STREAM").map((s) => ({ streamId: String(s.name).split("/").at(-1) ?? s.name, type: s.type, displayName: s.displayName })),
      keyEvents, customDefinitions: { dimensions: dims, metrics },
    };
  } catch (e) { return mapGa4Error(e); }
}

// ---------------------------------------------------------------- dates
const DAY = 86_400_000;
export const shiftDate = (v: string, days: number) => { const d = new Date(`${v}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export function dateInZone(now: Date, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const inclusiveDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1;
export function previousPeriod(r: { startDate: string; endDate: string }) {
  const days = inclusiveDays(r.startDate, r.endDate);
  const endDate = shiftDate(r.startDate, -1);
  return { startDate: shiftDate(endDate, -(days - 1)), endDate };
}
const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;

export function resolveGa4DateRange(i: { startDate?: string; endDate?: string }, tz: string, now = new Date()) {
  if (Boolean(i.startDate) !== Boolean(i.endDate)) throw new Ga4ReportError("validation_error", "Give startDate and endDate together, or leave both out.");
  const requested = i.startDate && i.endDate ? { startDate: i.startDate, endDate: i.endDate } : null;
  if (requested && (!validDate(requested.startDate) || !validDate(requested.endDate) || requested.startDate > requested.endDate))
    throw new Ga4ReportError("validation_error", "Dates need the form YYYY-MM-DD, and startDate may not come after endDate.");
  const lastComplete = shiftDate(dateInZone(now, tz), -1);
  let endDate = requested?.endDate ?? lastComplete;
  const startDate = requested?.startDate ?? shiftDate(endDate, -27);
  const warnings: string[] = [];
  if (endDate > lastComplete) { endDate = lastComplete; warnings.push("end_date_clamped"); }
  if (startDate > endDate) throw new Ga4ReportError("validation_error", "The start date falls after the most recent complete Analytics day.");
  return { requestedDateRange: requested, resolvedDateRange: { startDate, endDate }, warnings };
}

// ---------------------------------------------------------------- what each report asks for
export type ReportKind = "landing_pages" | "page_performance" | "key_events" | "traffic_acquisition" | "ecommerce_performance" | "site_search" | "audience_breakdown";
export type ReportInput = {
  projectId?: string; kind: ReportKind; startDate?: string; endDate?: string; limit?: number; offset?: number; channel?: "organic_search" | "all";
  includeDate?: boolean; breakdown?: "event" | "event_and_landing_page"; acquisitionBreakdown?: "channel_group" | "source_medium" | "campaign";
  ecommerceBreakdown?: "item" | "landing_page"; ecommerceOnlyWithTransactions?: boolean; audienceBreakdown?: "device" | "country" | "new_vs_returning"; comparePreviousPeriod?: boolean;
};
const DEFS = {
  landing_pages: { dimensions: ["hostName", "landingPage"], metrics: ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "sessionKeyEventRate", "transactions", "purchaseRevenue"], order: "sessions" },
  page_performance: { dimensions: ["hostName", "pagePath"], metrics: ["screenPageViews", "activeUsers", "userEngagementDuration", "keyEvents"], order: "screenPageViews" },
  key_events: { dimensions: ["eventName"], metrics: ["keyEvents", "totalUsers"], order: "keyEvents" },
  traffic_acquisition: { dimensions: ["sessionDefaultChannelGroup"], metrics: ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"], order: "sessions" },
  ecommerce_performance: { dimensions: ["itemName", "itemId"], metrics: ["itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue"], order: "itemRevenue" },
  site_search: { dimensions: ["searchTerm"], metrics: ["eventCount", "activeUsers", "sessions", "engagedSessions", "engagementRate"], order: "eventCount" },
  audience_breakdown: { dimensions: ["deviceCategory"], metrics: ["activeUsers", "sessions", "engagementRate", "keyEvents"], order: "activeUsers" },
} as const;
export const OVERVIEW_METRICS = ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"] as const;
const organicFilter = () => ({ filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } });

function definition(i: ReportInput): { dimensions: readonly string[]; metrics: readonly string[]; order: string } {
  if (i.kind === "ecommerce_performance" && i.ecommerceBreakdown === "landing_page") return { dimensions: ["hostName", "landingPage"], metrics: ["sessions", "transactions", "purchaseRevenue"], order: "purchaseRevenue" };
  return DEFS[i.kind];
}
function dimensionsFor(i: ReportInput, defaults: readonly string[]): string[] {
  if (i.kind === "traffic_acquisition") return [{ channel_group: "sessionDefaultChannelGroup", source_medium: "sessionSourceMedium", campaign: "sessionCampaignName" }[i.acquisitionBreakdown ?? "channel_group"]];
  if (i.kind === "audience_breakdown") return [{ device: "deviceCategory", country: "country", new_vs_returning: "newVsReturning" }[i.audienceBreakdown ?? "device"]];
  const d = [...defaults];
  if (i.kind === "page_performance" && i.includeDate) d.push("date");
  if (i.kind === "key_events" && i.breakdown === "event_and_landing_page") d.push("hostName", "landingPage");
  return d;
}
function dimensionFilter(i: ReportInput): unknown {
  if (i.kind === "site_search")
    return { andGroup: { expressions: [{ filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "view_search_results" } } }, { notExpression: { filter: { fieldName: "searchTerm", stringFilter: { matchType: "EXACT", value: "(not set)" } } } }] } };
  return (i.channel ?? "organic_search") === "organic_search" ? organicFilter() : undefined;
}
function metricFilter(i: ReportInput): unknown {
  const gt0 = (f: string) => ({ filter: { fieldName: f, numericFilter: { operation: "GREATER_THAN", value: { doubleValue: 0 } } } });
  if (i.kind === "key_events") return gt0("keyEvents");
  if (i.kind === "ecommerce_performance" && i.ecommerceBreakdown === "landing_page" && i.ecommerceOnlyWithTransactions) return gt0("transactions");
  return undefined;
}
function effectiveBreakdown(i: ReportInput): string {
  if (i.kind === "landing_pages") return "landing_page";
  if (i.kind === "page_performance") return i.includeDate ? "page_and_date" : "page";
  if (i.kind === "key_events") return i.breakdown ?? "event";
  if (i.kind === "traffic_acquisition") return i.acquisitionBreakdown ?? "channel_group";
  if (i.kind === "ecommerce_performance") return i.ecommerceBreakdown ?? "item";
  if (i.kind === "site_search") return "search_term";
  return i.audienceBreakdown ?? "device";
}

type RunRequest = { dateRanges: { startDate: string; endDate: string }[]; dimensions: { name: string }[]; metrics: { name: string }[]; dimensionFilter?: unknown; metricFilter?: unknown; offset: string; limit: string; orderBys: unknown[]; keepEmptyRows: boolean; returnPropertyQuota: boolean };
function buildRequest(i: ReportInput & { startDate: string; endDate: string; limit: number; offset: number }): RunRequest {
  const d = definition(i);
  return {
    dateRanges: [{ startDate: i.startDate, endDate: i.endDate }], dimensions: dimensionsFor(i, d.dimensions).map((name) => ({ name })), metrics: d.metrics.map((name) => ({ name })),
    dimensionFilter: dimensionFilter(i), metricFilter: metricFilter(i), offset: String(i.offset), limit: String(i.limit), orderBys: [{ metric: { metricName: d.order }, desc: true }], keepEmptyRows: false, returnPropertyQuota: true,
  };
}
function overviewRequest(i: { startDate: string; endDate: string; trend?: "daily" | "weekly" }): RunRequest {
  const dimensions = i.trend ? [{ name: i.trend === "daily" ? "date" : "yearWeek" }] : [];
  return {
    dateRanges: [{ startDate: i.startDate, endDate: i.endDate }], dimensions, metrics: OVERVIEW_METRICS.map((name) => ({ name })), dimensionFilter: organicFilter(),
    offset: "0", limit: i.trend ? "1000" : "1", orderBys: i.trend ? [{ dimension: { dimensionName: dimensions[0]!.name } }] : [], keepEmptyRows: false, returnPropertyQuota: true,
  };
}

// ---------------------------------------------------------------- cleaning up API responses
type Row = Record<string, string | number | null>;
type Quota = Record<string, { consumed: number; remaining: number }>;
type Normalized = { rows: Row[]; totalRowCount: number; reportMetadata: { dataLossFromOtherRow: boolean; subjectToThresholding: boolean; sampling: unknown[]; restrictedMetrics: { metricName: string; restrictedMetricTypes: string[] }[]; emptyReason: string | null; hasLimitedData: boolean }; quota: Quota | null };

function normalize(resp: any, req: RunRequest): Normalized {
  const expD = req.dimensions.map((d) => d.name), expM = req.metrics.map((m) => m.name);
  const dims: string[] = (resp.dimensionHeaders ?? []).map((h: any) => h.name), mets: string[] = (resp.metricHeaders ?? []).map((h: any) => h.name);
  const headerless = resp.dimensionHeaders === undefined && resp.metricHeaders === undefined && (resp.rows?.length ?? 0) === 0;
  if (!headerless && (dims.join("\0") !== expD.join("\0") || mets.join("\0") !== expM.join("\0"))) throw new MalformedResponse();
  const restricted = (resp.metadata?.schemaRestrictionResponse?.activeMetricRestrictions ?? []).map((r: any) => ({ metricName: r.metricName, restrictedMetricTypes: r.restrictedMetricTypes ?? [] }));
  const restrictedNames = new Set(restricted.map((r: any) => r.metricName));
  const rows: Row[] = (resp.rows ?? []).map((r: any) => {
    if ((r.dimensionValues?.length ?? 0) !== dims.length || (r.metricValues?.length ?? 0) !== mets.length) throw new MalformedResponse();
    const o: Row = {};
    dims.forEach((n, k) => (o[n] = r.dimensionValues[k]?.value ?? ""));
    mets.forEach((n, k) => { const v = Number(r.metricValues[k]?.value ?? ""); if (!restrictedNames.has(n) && !Number.isFinite(v)) throw new MalformedResponse(); o[n] = restrictedNames.has(n) ? null : v; });
    return o;
  });
  const sampling = resp.metadata?.samplingMetadatas ?? [];
  const m = resp.metadata ?? {};
  return {
    rows, totalRowCount: resp.rowCount ?? rows.length, quota: resp.propertyQuota ?? null,
    reportMetadata: {
      dataLossFromOtherRow: m.dataLossFromOtherRow ?? false, subjectToThresholding: m.subjectToThresholding ?? false, sampling, restrictedMetrics: restricted, emptyReason: m.emptyReason ?? null,
      hasLimitedData: Boolean(m.dataLossFromOtherRow) || Boolean(m.subjectToThresholding) || sampling.length > 0 || restricted.length > 0,
    },
  };
}

const run = (ctx: Ctx, c: Conn, req: RunRequest) => googleJson<any>(ctx, c.grant_id, `${apiBase(ctx, "analyticsdata.googleapis.com")}/v1beta/${c.property_id}:runReport`, { method: "POST", body: req });

// ---------------------------------------------------------------- previous-period comparison and diagnostics
const COMPLETE_LIMIT = 1000;
const num = (r: Row | undefined, m: string) => (typeof r?.[m] === "number" ? (r[m] as number) : null);
export function comparisonValue(cur: number | null, prev: number | null) {
  const absoluteChange = cur != null && prev != null ? cur - prev : null;
  return { current: cur, previous: prev, absoluteChange, percentChange: absoluteChange != null && prev != null && prev !== 0 ? absoluteChange / prev : null };
}
const supportsComparison = (i: ReportInput) =>
  i.kind === "key_events" ? (i.breakdown ?? "event") === "event" : i.kind === "traffic_acquisition" ? (i.acquisitionBreakdown ?? "channel_group") === "channel_group"
  : i.kind === "audience_breakdown" ? ["device", "new_vs_returning"].includes(i.audienceBreakdown ?? "device") : false;
const needsComplete = (i: ReportInput) => i.comparePreviousPeriod === true || (i.kind === "traffic_acquisition" && i.acquisitionBreakdown === "source_medium") || i.kind === "ecommerce_performance" || i.kind === "site_search";

function buildComparison(cur: Normalized, prev: Normalized, previousDateRange: { startDate: string; endDate: string }, dimensions: string[], metrics: string[]) {
  const key = (r: Row) => JSON.stringify(dimensions.map((d) => r[d] ?? null));
  const cm = new Map(cur.rows.map((r) => [key(r), r])), pm = new Map(prev.rows.map((r) => [key(r), r]));
  const keys = [...cm.keys(), ...[...pm.keys()].filter((k) => !cm.has(k))];
  return {
    previousDateRange, dimensions, metrics,
    rows: keys.map((k) => ({
      dimensions: Object.fromEntries(dimensions.map((d) => [d, cm.get(k)?.[d] ?? pm.get(k)?.[d] ?? null])),
      metrics: Object.fromEntries(metrics.map((m) => [m, comparisonValue(num(cm.get(k), m), num(pm.get(k), m))])),
    })),
    coverage: { complete: cur.rows.length === cur.totalRowCount && prev.rows.length === prev.totalRowCount, current: { fetchedRowCount: cur.rows.length, totalRowCount: cur.totalRowCount }, previous: { fetchedRowCount: prev.rows.length, totalRowCount: prev.totalRowCount } },
    reportMetadata: { hasLimitedData: cur.reportMetadata.hasLimitedData || prev.reportMetadata.hasLimitedData, current: cur.reportMetadata, previous: prev.reportMetadata },
    quota: prev.quota,
  };
}

function isInternalHost(value: string): boolean {
  const src = (value.split(" / ")[0] ?? "").toLowerCase().replace(/^https?:\/\//, "");
  if (src === "::1" || src.startsWith("[::1]")) return true;
  const host = src.split(":")[0] ?? "";
  if (host === "localhost" || host.startsWith("127.")) return true;
  const p = host.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x))) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}
const sum = (rows: Row[], m: string) => rows.reduce((s, r) => s + (num(r, m) ?? 0), 0);
const activity = (r: Normalized, detected: boolean) => (r.reportMetadata.hasLimitedData || r.rows.length !== r.totalRowCount ? "unknown" : detected ? "detected" : "none") as "detected" | "none" | "unknown";

function enhancements(report: Normalized, i: ReportInput, dateRange: { startDate: string; endDate: string }) {
  if (i.kind === "traffic_acquisition" && i.acquisitionBreakdown === "source_medium") {
    const complete = report.rows.length === report.totalRowCount;
    const coverage = { complete, limitedData: report.reportMetadata.hasLimitedData, fetchedRowCount: report.rows.length, totalRowCount: report.totalRowCount };
    if (!complete || report.reportMetadata.hasLimitedData) return { diagnostics: [], diagnosticCoverage: coverage };
    const diagnostics: Record<string, unknown>[] = [];
    const total = sum(report.rows, "sessions");
    const notSet = sum(report.rows.filter((r) => r.sessionSourceMedium === "(not set)"), "sessions");
    if (total > 0 && notSet / total >= 0.05) diagnostics.push({ code: "attribution_not_set_share_high", severity: "warning", message: "Many sessions carry no source/medium attribution.", evidence: { sessions: notSet, totalSessions: total, share: notSet / total }, threshold: { share: 0.05 } });
    const internal = report.rows.filter((r) => typeof r.sessionSourceMedium === "string" && isInternalHost(r.sessionSourceMedium));
    const internalSessions = sum(internal, "sessions");
    if (internalSessions > 0) diagnostics.push({ code: "internal_referral_traffic_detected", severity: "warning", message: "Referrals from local or private-network hosts show up in the acquisition data.", evidence: { sessions: internalSessions, sources: internal.map((r) => r.sessionSourceMedium) }, threshold: { sessions: 0 } });
    const groups = new Map<string, Set<string>>();
    for (const r of report.rows) if (typeof r.sessionSourceMedium === "string") groups.set(r.sessionSourceMedium.toLowerCase(), (groups.get(r.sessionSourceMedium.toLowerCase()) ?? new Set()).add(r.sessionSourceMedium));
    const variantGroups = [...groups.values()].filter((v) => v.size > 1).map((v) => [...v]);
    if (variantGroups.length) diagnostics.push({ code: "source_medium_case_variants_detected", severity: "info", message: "Some source/medium values differ only in upper/lower case.", evidence: { variantGroups }, threshold: { variantGroups: 0 } });
    return { diagnostics, diagnosticCoverage: coverage };
  }
  if (i.kind === "ecommerce_performance") {
    const breakdown = i.ecommerceBreakdown ?? "item";
    const metrics = breakdown === "item" ? ["itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue"] : ["transactions", "purchaseRevenue"];
    const totals = Object.fromEntries(metrics.map((m) => [m, sum(report.rows, m)]));
    const status = activity(report, Object.values(totals).some((v) => v > 0));
    const reason = status === "none" ? "No ecommerce activity matched this period and channel." : status === "unknown" ? "The report came back partial or sampled, so ecommerce activity cannot be judged." : null;
    return { diagnostics: status === "none" ? [{ code: "no_ecommerce_activity", severity: "info", message: reason, evidence: totals, threshold: { matchingActivity: 0 } }] : [], ecommerceActivity: { status, dateRange, channel: i.channel ?? "organic_search", breakdown, evidence: totals, reason } };
  }
  if (i.kind === "site_search") {
    const events = sum(report.rows, "eventCount");
    const status = activity(report, events > 0);
    const reason = status === "none" ? "No site-search terms were recorded for this period." : status === "unknown" ? "The report came back partial or sampled, so site-search activity cannot be judged." : null;
    return { diagnostics: status === "none" ? [{ code: "no_site_search_activity", severity: "info", message: reason, evidence: { searchTermCount: report.totalRowCount, searchEventCount: events }, threshold: { searchEvents: 0 } }] : [], siteSearchActivity: { status, dateRange, searchTermCount: report.totalRowCount, searchEventCount: events, reason } };
  }
  return { diagnostics: [] };
}

// ---------------------------------------------------------------- reports
export async function runGa4Report(ctx: Ctx, projectId: string, input: ReportInput, opts: { now?: Date } = {}) {
  const c = needConnection(ctx, projectId);
  const limit = input.limit ?? 100, offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > COMPLETE_LIMIT) throw new Ga4ReportError("validation_error", `limit must be an integer from 1 to ${COMPLETE_LIMIT}.`);
  if (!Number.isInteger(offset) || offset < 0) throw new Ga4ReportError("validation_error", "offset must be a non-negative integer.");
  const channel = input.channel ?? "organic_search";
  const dr = resolveGa4DateRange(input, c.property_time_zone, opts.now);
  if (input.comparePreviousPeriod && !supportsComparison(input))
    throw new Ga4ReportError("validation_error", "A comparison with the previous period works only for key events by event, acquisition by channel group, device audiences, and new-versus-returning audiences.");
  const complete = needsComplete(input);
  const d = definition(input);
  const dimensions = dimensionsFor(input, d.dimensions), metrics = [...d.metrics];
  const base = { ...input, channel };
  const request = buildRequest({ ...base, ...dr.resolvedDateRange, limit: complete ? COMPLETE_LIMIT : limit, offset: complete ? 0 : offset });
  try {
    const prevRange = input.comparePreviousPeriod ? previousPeriod(dr.resolvedDateRange) : null;
    const prevReq = prevRange ? buildRequest({ ...base, ...prevRange, limit: COMPLETE_LIMIT, offset: 0 }) : null;
    const [resp, prevResp] = await Promise.all([run(ctx, c, request), prevReq ? run(ctx, c, prevReq) : null]);
    const normalized = normalize(resp, request);
    const prevNorm = prevResp && prevReq ? normalize(prevResp, prevReq) : null;
    let rows = complete ? normalized.rows.slice(offset, offset + limit) : normalized.rows;
    if (complete && !(normalized.totalRowCount <= normalized.rows.length || offset + limit <= normalized.rows.length)) {
      const pageReq = { ...request, offset: String(offset), limit: String(limit) };
      rows = normalize(await run(ctx, c, pageReq), pageReq).rows;
    }
    if (rows.length === 0 && offset < normalized.totalRowCount) throw new MalformedResponse();
    const next = offset + rows.length, hasMore = next < normalized.totalRowCount;
    const comparison = prevNorm && prevRange ? buildComparison(normalized, prevNorm, prevRange, dimensions, metrics) : undefined;
    return {
      status: "ok" as const,
      source: { provider: "google_analytics" as const, propertyId: c.property_id, propertyDisplayName: c.property_display_name },
      request: { requestedDateRange: dr.requestedDateRange, resolvedDateRange: dr.resolvedDateRange, propertyTimeZone: c.property_time_zone, currencyCode: c.property_currency_code, channel, reportKind: input.kind, breakdown: effectiveBreakdown(input), dimensions, metrics, flags: { includeDate: input.includeDate ?? false, onlyWithTransactions: input.ecommerceOnlyWithTransactions ?? false }, limit, offset },
      rowCount: rows.length, totalRowCount: normalized.totalRowCount, rows,
      pageInfo: { offset, limit, hasMore, nextOffset: hasMore ? next : null },
      reportMetadata: normalized.reportMetadata, quota: normalized.quota,
      warnings: [...dr.warnings, ...(comparison && !comparison.coverage.complete ? ["comparison_incomplete"] : [])],
      ...enhancements(normalized, input, dr.resolvedDateRange), comparison,
    };
  } catch (e) { return mapGa4Error(e); }
}
export type Ga4ReportResult = Awaited<ReturnType<typeof runGa4Report>>;

export async function getOrganicOverview(ctx: Ctx, projectId: string, input: { startDate?: string; endDate?: string; trend?: "daily" | "weekly" }, opts: { now?: Date } = {}) {
  const c = needConnection(ctx, projectId);
  const dr = resolveGa4DateRange(input, c.property_time_zone, opts.now);
  const prevRange = previousPeriod(dr.resolvedDateRange);
  const trend = input.trend ?? "daily";
  const reqs = [overviewRequest(dr.resolvedDateRange), overviewRequest(prevRange), overviewRequest({ ...dr.resolvedDateRange, trend })];
  try {
    const [cur, prev, tr] = (await Promise.all(reqs.map((r) => run(ctx, c, r)))).map((resp, k) => normalize(resp, reqs[k]!));
    const current = cur!.rows[0] ?? null, previous = prev!.rows[0] ?? null;
    const limited = [cur!, prev!, tr!].some((r) => r.reportMetadata.hasLimitedData);
    const diagnostics: Record<string, unknown>[] = [];
    const cv = typeof current?.keyEvents === "number" ? current.keyEvents : null, pv = typeof previous?.keyEvents === "number" ? previous.keyEvents : null;
    if (!limited && cv != null && pv != null && pv >= 5 && (cv - pv) / pv <= -0.5)
      diagnostics.push({ code: "key_events_sharp_decline", severity: "warning", message: "Organic key events dropped steeply against the previous period of equal length.", evidence: { current: cv, previous: pv, percentChange: (cv - pv) / pv }, threshold: { minimumPreviousKeyEvents: 5, percentChange: -0.5 } });
    return {
      status: "ok" as const,
      source: { provider: "google_analytics" as const, propertyId: c.property_id, propertyDisplayName: c.property_display_name },
      request: { requestedDateRange: dr.requestedDateRange, resolvedDateRange: dr.resolvedDateRange, previousDateRange: prevRange, propertyTimeZone: c.property_time_zone, currencyCode: c.property_currency_code, channel: "organic_search" as const, trend },
      current, previous, comparison: Object.fromEntries(OVERVIEW_METRICS.map((m) => [m, comparisonValue(num(current ?? undefined, m), num(previous ?? undefined, m))])),
      trend: tr!.rows, diagnostics,
      reportMetadata: { hasLimitedData: limited, reports: [cur!, prev!, tr!].map((r) => r.reportMetadata) },
      quota: tr!.quota ?? cur!.quota,
      warnings: [...dr.warnings, ...(tr!.totalRowCount > tr!.rows.length ? ["trend_truncated"] : [])],
    };
  } catch (e) { return mapGa4Error(e); }
}

// ---------------------------------------------------------------- search opportunities (Search Console x Analytics)
function pageKey(value: string): string | null {
  const t = value.trim();
  if (!t || t === "(not set)") return null;
  try {
    const u = new URL(t.includes("://") ? t : `https://${t}`);
    let host = u.hostname.toLowerCase();
    if (u.port && !((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443"))) host += `:${u.port}`;
    let path = u.pathname || "/";
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch { return null; }
}
const percentileRanks = (v: number[]) => (v.length === 0 ? [] : v.length === 1 ? [1] : v.map((x) => v.filter((y) => y < x).length / (v.length - 1)));
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export async function getSearchOpportunities(ctx: Ctx, projectId: string, input: { startDate?: string; endDate?: string; limit?: number }, opts: { now?: Date } = {}) {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Ga4ReportError("validation_error", "limit must be an integer from 1 to 100.");
  const ga4c = getGa4Connection(ctx, projectId);
  const gscc = getGscConnection(ctx, projectId);
  if (!ga4c) throw new Ga4ReportError("ga4_not_connected", "No Google Analytics property is linked to this project.");
  if (!gscc) throw new GscNotConnectedError();
  const now = opts.now ?? new Date();
  const dates = !input.startDate && !input.endDate
    ? (() => { const endDate = shiftDate(dateInZone(now, ga4c.property_time_zone), -3); return { startDate: shiftDate(endDate, -27), endDate }; })()
    : resolveGa4DateRange(input, ga4c.property_time_zone, now).resolvedDateRange;
  const gsc = await getGscPerformance(ctx, projectId, { dimensions: ["page"], startDate: dates.startDate, endDate: dates.endDate, rowLimit: 1000, startRow: 0, type: "web", dataState: "final" });
  const ga4 = await runGa4Report(ctx, projectId, { kind: "landing_pages", startDate: dates.startDate, endDate: dates.endDate, limit: 1000, offset: 0, channel: "organic_search" });
  const byPage = new Map<string, Row>();
  let invalid = 0;
  for (const r of ga4.rows) {
    const k = pageKey(`${typeof r.hostName === "string" ? r.hostName : ""}${typeof r.landingPage === "string" ? r.landingPage : ""}`);
    if (!k) invalid++; else byPage.set(k, r);
  }
  const n = (r: Row, f: string) => (typeof r[f] === "number" && Number.isFinite(r[f] as number) ? (r[f] as number) : 0);
  type Cand = { page: string; normalizedPage: string | null; clicks: number; impressions: number; ctr: number; position: number; joinStatus: "joined" | "gsc_only"; ga4: Record<string, number | null> | null; score: number | null; scoreComponents: { demand: number; businessValue: number; reachability: number } | null };
  const candidates: Cand[] = gsc.rows.filter((r) => r.position >= 4 && r.position <= 20).map((r) => {
    const page = r.keys?.[0] ?? "", np = pageKey(page), a = np ? byPage.get(np) : undefined;
    return { page, normalizedPage: np, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, joinStatus: a ? "joined" : "gsc_only", score: null, scoreComponents: null,
      ga4: a ? { sessions: n(a, "sessions"), activeUsers: n(a, "activeUsers"), engagedSessions: n(a, "engagedSessions"), engagementRate: n(a, "engagementRate"), keyEvents: n(a, "keyEvents"), sessionKeyEventRate: n(a, "sessionKeyEventRate"), transactions: n(a, "transactions"), purchaseRevenue: typeof a.purchaseRevenue === "number" ? a.purchaseRevenue : null } : null };
  });
  const joined = candidates.filter((x) => x.ga4 !== null);
  const fallback = joined.length > 0 && joined.every((x) => x.ga4!.keyEvents === 0);
  const demand = percentileRanks(joined.map((x) => Math.log1p(x.impressions)));
  const value = percentileRanks(joined.map((x) => (fallback ? x.ga4!.engagementRate! : x.ga4!.sessionKeyEventRate!)));
  const reach = percentileRanks(joined.map((x) => 20 - x.position));
  joined.forEach((x, k) => {
    const comp = { demand: round4(demand[k] ?? 0), businessValue: round4(value[k] ?? 0), reachability: round4(reach[k] ?? 0) };
    x.scoreComponents = comp;
    x.score = Math.round(100 * (0.5 * comp.demand + 0.3 * comp.businessValue + 0.2 * comp.reachability));
  });
  candidates.sort((a, b) => (a.score == null && b.score != null ? 1 : a.score != null && b.score == null ? -1 : (b.score ?? 0) - (a.score ?? 0) || b.impressions - a.impressions));
  const returned = candidates.slice(0, limit);
  return {
    status: "ok" as const,
    source: { searchConsoleSiteUrl: gsc.siteUrl, googleAnalyticsPropertyId: ga4.source.propertyId, googleAnalyticsPropertyDisplayName: ga4.source.propertyDisplayName },
    request: { dateRange: dates, limit, searchConsoleTimeZone: "America/Los_Angeles", googleAnalyticsTimeZone: ga4.request.propertyTimeZone },
    rowCount: returned.length, totalCandidateRows: candidates.length, rows: returned,
    scoring: { formula: "round(100 * (0.5 * demand + 0.3 * businessValue + 0.2 * reachability))", businessValueMetric: fallback ? "engagementRate" : "sessionKeyEventRate", engagementFallback: fallback, scoreDataLimited: ga4.reportMetadata.hasLimitedData },
    coverage: { gscRowsConsidered: gsc.rows.length, ga4RowsConsidered: ga4.rows.length, matchedRows: joined.length, unmatchedGscRows: candidates.length - joined.length, unmatchedGa4Rows: Math.max(byPage.size - joined.length, 0) + invalid },
    truncated: { gsc: gsc.rows.length >= 1000, ga4: ga4.totalRowCount > ga4.rows.length, candidates: returned.length < candidates.length },
    warnings: ga4.request.propertyTimeZone === "America/Los_Angeles" ? ga4.warnings : [...ga4.warnings, "source_time_zones_differ"],
    reportMetadata: ga4.reportMetadata, quota: ga4.quota,
  };
}
