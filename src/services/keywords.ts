import { createHash } from "node:crypto";
import type { Ctx } from "../ctx.ts";
import { nowIso } from "../db.ts";
import { AppError } from "../errors.ts";
import { getProject } from "./projects.ts";
import { assertLanguageForLocation, countryName, getKeywordDataProvider, isoCountryCode, resolveMarket, type Market } from "./markets.ts";

export type MonthlySearch = { year: number; month: number; searchVolume: number };
export type ResearchRow = {
  keyword: string; searchVolume: number | null; keywordDifficulty: number | null; cpc: number | null;
  competition: number | null; intent: Intent;
};
type Intent = "informational" | "commercial" | "transactional" | "navigational" | "unknown";
type Enriched = ResearchRow & { trend: MonthlySearch[] };

type MonthlyRaw = { year?: number | null; month?: number | null; search_volume?: number | null }[] | null;
type LabsKeywordItem = {
  keyword?: string;
  keyword_info?: { search_volume?: number | null; cpc?: number | null; competition?: number | null; competition_level?: string | null; monthly_searches?: MonthlyRaw } | null;
  keyword_info_normalized_with_clickstream?: { search_volume?: number | null; monthly_searches?: MonthlyRaw } | null;
  keyword_properties?: { keyword_difficulty?: number | null } | null;
  search_intent_info?: { main_intent?: string | null } | null;
};
type AdsItem = { keyword?: string; search_volume?: number | null; cpc?: number | null; competition?: string | null; competition_index?: number | null; monthly_searches?: MonthlyRaw };

const MIN_NON_SEED_FOR_AUTO = 5;
const METRICS_BATCH = 700;
const RESEARCH_CACHE_TTL_MS = 86_400_000;
export const MAX_SEEDS_PER_CALL = 5;

export const normalizeKeyword = (k: string) => k.trim().toLowerCase();

export function normalizeIntent(raw: string | null | undefined): Intent {
  if (!raw) return "unknown";
  const v = raw.toLowerCase();
  if (v.includes("inform")) return "informational";
  if (v.includes("commerc")) return "commercial";
  if (v.includes("transact")) return "transactional";
  if (v.includes("navig")) return "navigational";
  return "unknown";
}

const trendOf = (m: MonthlyRaw | undefined): MonthlySearch[] =>
  (m ?? []).map((e) => ({ year: e.year ?? 0, month: e.month ?? 0, searchVolume: e.search_volume ?? 0 }));

function mapLabs(items: LabsKeywordItem[] | null | undefined): Enriched[] {
  const rows: Enriched[] = [];
  const seen = new Set<string>();
  for (const it of items ?? []) {
    if (!it.keyword) continue;
    const k = normalizeKeyword(it.keyword);
    if (seen.has(k)) continue;
    seen.add(k);
    // The clickstream-normalised block exists only when the caller opted in; prefer it when present.
    const info = it.keyword_info_normalized_with_clickstream?.search_volume ? it.keyword_info_normalized_with_clickstream : it.keyword_info;
    rows.push({
      keyword: k, searchVolume: info?.search_volume ?? null, trend: trendOf(info?.monthly_searches),
      cpc: it.keyword_info?.cpc ?? null, competition: it.keyword_info?.competition ?? null,
      keywordDifficulty: it.keyword_properties?.keyword_difficulty ?? null, intent: normalizeIntent(it.search_intent_info?.main_intent),
    });
  }
  return rows;
}

/** Google Ads rows carry volume, CPC and paid competition but no difficulty or intent. */
function mapAds(items: AdsItem[] | null | undefined): Enriched[] {
  const rows: Enriched[] = [];
  const seen = new Set<string>();
  for (const it of items ?? []) {
    if (!it.keyword) continue;
    const k = normalizeKeyword(it.keyword);
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({
      keyword: k, searchVolume: it.search_volume ?? null, trend: trendOf(it.monthly_searches), cpc: it.cpc ?? null,
      competition: it.competition_index != null ? it.competition_index / 100 : null, keywordDifficulty: null, intent: "unknown",
    });
  }
  return rows;
}

/** Alternate rows from two sources, deduplicating, so a volume-sorted source cannot crowd out the other. */
export function interleaveRows(first: Enriched[], second: Enriched[], limit: number): Enriched[] {
  const rows: Enriched[] = [];
  const seen = new Set<string>();
  const longest = Math.max(first.length, second.length);
  for (let i = 0; i < longest && rows.length < limit; i++)
    for (const src of [first, second]) {
      const row = src[i];
      if (!row || seen.has(row.keyword) || rows.length >= limit) continue;
      seen.add(row.keyword);
      rows.push(row);
    }
  return rows;
}

// Google Ads rejects a whole task when one keyword has these symbols, an emoji, >80 chars or >10 words.
const ADS_INVALID = /[!@%,*(){}<>|^~;=?`]|\p{Extended_Pictographic}/u;
export const isAdsKeyword = (k: string) => k.length <= 80 && k.split(/\s+/).length <= 10 && !ADS_INVALID.test(k);

type LabsParams = { seed: string; m: Market; limit: number; clickstream: boolean; ignoreSynonyms: boolean };

async function labsRows(ctx: Ctx, kind: "suggestions" | "ideas" | "related", p: LabsParams): Promise<Enriched[]> {
  const common = { location_code: p.m.locationCode, language_code: p.m.languageCode, limit: p.limit, include_clickstream_data: p.clickstream, ignore_synonyms: p.ignoreSynonyms };
  if (kind === "suggestions") {
    const r = await ctx.dfs.first<{ items?: LabsKeywordItem[] | null }>("/v3/dataforseo_labs/google/keyword_suggestions/live", { keyword: p.seed, ...common });
    return mapLabs(r.result?.items);
  }
  if (kind === "ideas") {
    const r = await ctx.dfs.first<{ items?: LabsKeywordItem[] | null }>("/v3/dataforseo_labs/google/keyword_ideas/live", { keywords: [p.seed], ...common });
    return mapLabs(r.result?.items);
  }
  const r = await ctx.dfs.first<{ items?: { keyword_data?: LabsKeywordItem | null }[] | null }>("/v3/dataforseo_labs/google/related_keywords/live", { keyword: p.seed, depth: 3, ...common });
  return mapLabs((r.result?.items ?? []).map((i) => i.keyword_data).filter((d): d is LabsKeywordItem => d != null));
}

async function autoRows(ctx: Ctx, p: LabsParams): Promise<{ rows: Enriched[]; usedFallback: boolean }> {
  const half = { ...p, limit: Math.ceil(p.limit / 2) };
  // Settled, not all: both legs are billed, so one failing must not hide the other's spend.
  const [sug, ideas] = await Promise.allSettled([labsRows(ctx, "suggestions", half), labsRows(ctx, "ideas", half)]);
  if (sug.status === "rejected") throw sug.reason;
  if (ideas.status === "rejected") throw ideas.reason;
  const blended = interleaveRows(sug.value, ideas.value, p.limit);
  if (blended.filter((r) => r.keyword !== p.seed).length >= MIN_NON_SEED_FOR_AUTO) return { rows: blended, usedFallback: false };
  // Thin result for an obscure seed: top up from the related-keywords graph.
  const related = await labsRows(ctx, "related", p);
  return { rows: interleaveRows(blended, related, p.limit), usedFallback: true };
}

async function adsSearchVolume(ctx: Ctx, keywords: string[], m: Market, locationName?: string): Promise<AdsItem[]> {
  const ok = keywords.filter(isAdsKeyword);
  if (ok.length === 0) return [];
  const r = await ctx.dfs.request<AdsItem[]>("/v3/keywords_data/google_ads/search_volume/live", {
    keywords: ok, language_code: m.languageCode, ...(locationName ? { location_name: locationName } : { location_code: m.locationCode }),
  });
  return r.result;
}

type SerpLoc = { location_name: string; location_code: number; location_type: string };
export async function serpLocationsForCountry(ctx: Ctx, iso: string): Promise<SerpLoc[]> {
  const key = `serp-locations:${iso.toUpperCase()}`;
  const hit = ctx.db.prepare("SELECT value FROM kv_cache WHERE key=? AND expires_at>?").get(key, Date.now()) as { value: string } | undefined;
  if (hit) return JSON.parse(hit.value) as SerpLoc[];
  const r = await ctx.dfs.request<SerpLoc[]>(`/v3/serp/google/locations/${encodeURIComponent(iso.toUpperCase())}`);
  ctx.db.prepare("INSERT OR REPLACE INTO kv_cache (key,value,expires_at) VALUES (?,?,?)").run(key, JSON.stringify(r.result), Date.now() + 30 * 86_400_000);
  return r.result;
}

const label = (n: string) => n.split(",").map((s) => s.trim()).join(", ");
async function assertLocalLocation(ctx: Ctx, m: Market, locationName: string) {
  const all = await serpLocationsForCountry(ctx, isoCountryCode(m.locationCode));
  if (all.some((l) => l.location_name === locationName)) return;
  throw new AppError("VALIDATION_ERROR", `No city, county or region called "${label(locationName)}" exists in ${countryName(m.locationCode)}. Use search_serp_locations to find the exact name.`);
}

function persist(ctx: Ctx, projectId: string, m: Market, rows: Enriched[]) {
  const stmt = ctx.db.prepare(
    `INSERT INTO keyword_metrics (project_id,keyword,location_code,language_code,search_volume,cpc,competition,keyword_difficulty,intent,monthly_searches,fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,keyword,location_code,language_code) DO UPDATE SET
     search_volume=excluded.search_volume, cpc=excluded.cpc, competition=excluded.competition, keyword_difficulty=excluded.keyword_difficulty,
     intent=excluded.intent, monthly_searches=excluded.monthly_searches, fetched_at=excluded.fetched_at`,
  );
  const now = nowIso();
  ctx.db.exec("BEGIN");
  try {
    for (const r of rows) stmt.run(projectId, r.keyword, m.locationCode, m.languageCode, r.searchVolume, r.cpc, r.competition, r.keywordDifficulty, r.intent, JSON.stringify(r.trend), now);
    ctx.db.exec("COMMIT");
  } catch (e) {
    ctx.db.exec("ROLLBACK");
    console.error("persist keyword metrics failed", e);
  }
}

const strip = ({ trend: _t, ...row }: Enriched): ResearchRow => row;

type SeedInput = { seed: string; locationCode?: number; languageCode?: string; locationName?: string };

async function researchOne(
  ctx: Ctx, projectId: string, project: Market, s: SeedInput,
  opts: { resultLimit: number; clickstream: boolean; group: boolean },
) {
  const seed = normalizeKeyword(s.seed);
  if (!seed) throw new AppError("VALIDATION_ERROR", "A seed keyword cannot be blank");
  const m = resolveMarket({ locationCode: s.locationCode, languageCode: s.languageCode }, project);
  assertLanguageForLocation(m.locationCode, m.languageCode);
  const provider = getKeywordDataProvider(m.locationCode);
  // Labs-only knobs do not exist for Google-Ads countries; a local request never pays for clickstream.
  const clickstream = provider === "google_ads" || s.locationName ? false : opts.clickstream;
  const group = provider === "google_ads" ? false : opts.group;
  if (s.locationName) await assertLocalLocation(ctx, m, s.locationName);

  const cacheKey = "kw:research:" + createHash("sha1").update(JSON.stringify([5, projectId, seed, m, opts.resultLimit, clickstream, group, s.locationName ?? null])).digest("hex");
  const hit = ctx.db.prepare("SELECT value FROM kv_cache WHERE key=? AND expires_at>?").get(cacheKey, Date.now()) as { value: string } | undefined;
  let result: { rows: Enriched[]; source: string; usedFallback: boolean } | null = hit ? (JSON.parse(hit.value) as typeof result) : null;
  if (result && result.rows.length === 0) result = null;

  if (!result) {
    const nationalParams: LabsParams = { seed, m, limit: opts.resultLimit, clickstream, ignoreSynonyms: !group };
    if (provider === "google_ads") {
      const r = await ctx.dfs.request<AdsItem[]>("/v3/keywords_data/google_ads/keywords_for_keywords/live", { keywords: [seed], location_code: m.locationCode, language_code: m.languageCode, sort_by: "search_volume" });
      result = { rows: mapAds(r.result).slice(0, opts.resultLimit), source: "google_ads", usedFallback: false };
    } else {
      const auto = await autoRows(ctx, nationalParams);
      result = { rows: auto.rows, source: "blended", usedFallback: auto.usedFallback };
    }
    ctx.db.prepare("INSERT OR REPLACE INTO kv_cache (key,value,expires_at) VALUES (?,?,?)").run(cacheKey, JSON.stringify(result), Date.now() + RESEARCH_CACHE_TTL_MS);
    if (!s.locationName) persist(ctx, projectId, m, result.rows);
  }
  let rows = result.rows;
  if (s.locationName) {
    // Keyword ideas, difficulty and intent stay national; volume, CPC and competition become local.
    persist(ctx, projectId, m, rows);
    const local = new Map(mapAds(await adsSearchVolume(ctx, rows.map((r) => r.keyword), m, s.locationName)).map((r) => [r.keyword, r]));
    rows = rows.map((r) => {
      const l = local.get(r.keyword);
      return { ...r, searchVolume: l?.searchVolume ?? null, trend: l?.trend ?? [], cpc: l?.cpc ?? null, competition: l?.competition ?? null };
    });
  }
  return { seed: s.seed, ok: true as const, rowCount: rows.length, source: result.source, usedFallback: result.usedFallback, rows: rows.map(strip) };
}

export async function researchKeywords(
  ctx: Ctx, projectId: string,
  input: { seeds: SeedInput[]; resultLimit?: number; includeClickstreamData?: boolean; groupKeywords?: boolean },
) {
  const project = getProject(ctx, projectId);
  if (input.seeds.length > MAX_SEEDS_PER_CALL) throw new AppError("VALIDATION_ERROR", `A single call can research up to ${MAX_SEEDS_PER_CALL} seeds; split the list.`);
  const opts = { resultLimit: input.resultLimit ?? 150, clickstream: Boolean(input.includeClickstreamData), group: Boolean(input.groupKeywords) };
  const results = await Promise.all(input.seeds.map(async (s) => {
    try {
      return await researchOne(ctx, projectId, project, s, opts);
    } catch (e) {
      if (e instanceof AppError && (e.code === "NOT_CONFIGURED" || e.code === "UNAUTHENTICATED")) throw e;
      return { seed: s.seed, ok: false as const, error: (e as Error).message };
    }
  }));
  return { results };
}

type MetricRow = { keyword: string; search_volume: number | null; keyword_difficulty: number | null; main_intent: string | null; cpc: number | null; competition: number | null; competition_level: string | null; monthly_searches?: { year: number; month: number; search_volume: number }[] | null };

export async function getKeywordMetrics(
  ctx: Ctx, projectId: string,
  input: { keywords: string[]; locationCode?: number; languageCode?: string; includeMonthlyTrends?: boolean; includeClickstreamData?: boolean; sortBy?: "search_volume" | "keyword_difficulty" | "cpc" | "competition" },
) {
  const project = getProject(ctx, projectId);
  const m = resolveMarket(input, project);
  // Validate the RESOLVED pair: an explicit language with an omitted location checks against the project's location.
  assertLanguageForLocation(m.locationCode, m.languageCode);
  const useAds = getKeywordDataProvider(m.locationCode) === "google_ads";
  const rows: MetricRow[] = [];
  const persisted: Enriched[] = [];
  for (let i = 0; i < input.keywords.length; i += METRICS_BATCH) {
    const keywords = input.keywords.slice(i, i + METRICS_BATCH);
    if (useAds) {
      for (const it of await adsSearchVolume(ctx, keywords, m)) {
        if (!it.keyword) continue;
        const e = mapAds([it])[0]!;
        persisted.push(e);
        rows.push({ keyword: it.keyword, search_volume: it.search_volume ?? null, keyword_difficulty: null, main_intent: null, cpc: it.cpc ?? null, competition: it.competition_index != null ? it.competition_index / 100 : null, competition_level: it.competition ?? null, monthly_searches: monthly(trendOf(it.monthly_searches)) });
      }
    } else {
      const r = await ctx.dfs.first<{ items?: LabsKeywordItem[] | null }>("/v3/dataforseo_labs/google/keyword_overview/live", { keywords, location_code: m.locationCode, language_code: m.languageCode, include_clickstream_data: Boolean(input.includeClickstreamData) });
      for (const it of r.result?.items ?? []) {
        if (!it.keyword) continue;
        const cs = it.keyword_info_normalized_with_clickstream;
        const usesCs = cs?.search_volume != null;
        const info = it.keyword_info;
        rows.push({
          keyword: it.keyword, search_volume: cs?.search_volume ?? info?.search_volume ?? null,
          keyword_difficulty: it.keyword_properties?.keyword_difficulty ?? null, main_intent: it.search_intent_info?.main_intent ?? null,
          cpc: info?.cpc ?? null, competition: info?.competition ?? null, competition_level: info?.competition_level ?? null,
          monthly_searches: monthly(trendOf(usesCs ? cs?.monthly_searches : info?.monthly_searches)),
        });
        persisted.push(mapLabs([it])[0]!);
      }
    }
  }
  if (persisted.length) persist(ctx, projectId, m, persisted);
  const key = input.sortBy ?? "search_volume";
  const sorted = [...rows].sort((a, b) => (typeof b[key] === "number" ? (b[key] as number) : 0) - (typeof a[key] === "number" ? (a[key] as number) : 0));
  const out = sorted.map((r) => {
    if (input.includeMonthlyTrends === false) { const { monthly_searches: _m, ...rest } = r; return rest; }
    return r;
  });
  return { keywords: out };
}

const monthly = (t: MonthlySearch[]) => (t.length ? t.map((e) => ({ year: e.year, month: e.month, search_volume: e.searchVolume })) : null);
