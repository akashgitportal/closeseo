import type { Ctx } from "../ctx.ts";
import { AppError } from "../errors.ts";
import { getProject } from "./projects.ts";
import { assertLabsLocationCode, assertLanguageForLocation, DEFAULT_LOCATION, resolveLabsMarket, type Market } from "./markets.ts";
import { joinFilters, parseResearchTarget, rankedKeywordsScopeFilter, type ResearchScope } from "./researchScope.ts";
import { hostMatchesDomain } from "../domain-utils.ts";

const OVERVIEW_TTL_MS = 12 * 3_600_000;

type MarketArgs = { market?: { country?: string }; locationCode?: number; languageCode?: string };

/** Market for a Labs-only tool. `market` is the legacy US selector; an explicit location/language wins. */
function labsMarket(ctx: Ctx, projectId: string, a: MarketArgs): Market {
  const project = getProject(ctx, projectId);
  let m: Market;
  if (a.locationCode != null || a.languageCode != null) m = resolveLabsMarket({ locationCode: a.locationCode, languageCode: a.languageCode }, project);
  else if (a.market?.country != null) m = { locationCode: DEFAULT_LOCATION, languageCode: "en" };
  else m = resolveLabsMarket({}, project);
  assertLabsLocationCode(m.locationCode);
  assertLanguageForLocation(m.locationCode, m.languageCode);
  return m;
}

const legacyScope = (includeSubdomains: boolean | undefined): ResearchScope | undefined =>
  includeSubdomains == null ? undefined : includeSubdomains ? "subdomains" : "domain";

export async function getDomainOverview(
  ctx: Ctx, projectId: string,
  i: { domain: string; scope?: ResearchScope; includeSubdomains?: boolean; locationCode?: number; languageCode?: string },
) {
  const project = getProject(ctx, projectId);
  const m = resolveLabsMarket(i, project);
  assertLabsLocationCode(m.locationCode);
  assertLanguageForLocation(m.locationCode, m.languageCode);
  const target = parseResearchTarget(i.domain, i.scope ?? legacyScope(i.includeSubdomains));
  // domain_rank_overview has no filters and always covers hostname + subdomains, so every scope shares one entry.
  const key = `domain:overview:${projectId}:${target.hostname}:${m.locationCode}:${m.languageCode}`;
  const hit = ctx.db.prepare("SELECT value FROM kv_cache WHERE key=? AND expires_at>?").get(key, Date.now()) as { value: string } | undefined;
  type Stored = { domain: string; organicTraffic: number | null; organicKeywords: number | null; backlinks: null; referringDomains: null; hasData: boolean; fetchedAt: string };
  let stored: Stored | null = hit ? (JSON.parse(hit.value) as Stored) : null;
  if (stored?.hasData !== true) stored = null;
  if (!stored) {
    const r = await ctx.dfs.first<{ items?: { metrics?: { organic?: { etv?: number | null; count?: number | null } | null } | null }[] | null }>(
      "/v3/dataforseo_labs/google/domain_rank_overview/live",
      { target: target.hostname, location_code: m.locationCode, language_code: m.languageCode },
    );
    const organic = r.result?.items?.[0]?.metrics?.organic;
    const organicKeywords = organic?.count != null ? Math.round(organic.count) : null;
    stored = {
      domain: target.hostname,
      organicTraffic: organic?.etv != null ? Math.round(organic.etv) : null,
      organicKeywords, backlinks: null, referringDomains: null,
      hasData: organicKeywords != null && organicKeywords > 0, fetchedAt: new Date().toISOString(),
    };
    if (stored.hasData) ctx.db.prepare("INSERT OR REPLACE INTO kv_cache (key,value,expires_at) VALUES (?,?,?)").run(key, JSON.stringify(stored), Date.now() + OVERVIEW_TTL_MS);
  }
  return { ...stored, scope: target.scope, displayTarget: target.display };
}

const RANKED_ORDER = {
  rank: "ranked_serp_element.serp_item.rank_absolute,asc",
  search_volume: "keyword_data.keyword_info.search_volume,desc",
  traffic_estimate: "ranked_serp_element.serp_item.etv,desc",
  cpc: "keyword_data.keyword_info.cpc,desc",
} as const;

type RankedItem = Record<string, any>;

export async function getRankedKeywords(
  ctx: Ctx, projectId: string,
  i: MarketArgs & {
    target: string; scope?: ResearchScope; resultTypes?: string[]; includeSubdomains?: boolean; minSearchVolume?: number; maxRank?: number;
    excludeBrandTerms?: string[]; sortBy?: keyof typeof RANKED_ORDER; limit?: number; offset?: number;
  },
) {
  // Legacy includeSubdomains selects between whole-host scopes for bare domains and means "exact page" for URLs.
  const base = parseResearchTarget(i.target);
  const legacy = i.includeSubdomains == null ? undefined : base.path === "" ? legacyScope(i.includeSubdomains) : "exact_url";
  const requested = i.scope ?? legacy;
  const target = requested ? parseResearchTarget(i.target, requested) : base;
  const m = labsMarket(ctx, projectId, i);
  const filters = joinFilters([
    rankedKeywordsScopeFilter(target) ?? null,
    i.minSearchVolume != null ? ["keyword_data.keyword_info.search_volume", ">=", i.minSearchVolume] : null,
    i.maxRank != null ? ["ranked_serp_element.serp_item.rank_absolute", "<=", i.maxRank] : null,
    ...(i.excludeBrandTerms ?? []).map((t) => ["keyword_data.keyword", "not_ilike", `%${t}%`]),
  ]);
  const r = await ctx.dfs.first<{ total_count?: number | null; items?: RankedItem[] | null }>("/v3/dataforseo_labs/google/ranked_keywords/live", {
    target: target.hostname, location_code: m.locationCode, language_code: m.languageCode,
    item_types: i.resultTypes ?? ["organic", "paid"], limit: i.limit ?? 50, ...(i.offset ? { offset: i.offset } : {}),
    order_by: [RANKED_ORDER[i.sortBy ?? "search_volume"]], ...(filters ? { filters } : {}),
  });
  return { keywords: r.result?.items ?? [], totalCount: r.result?.total_count ?? null, target: target.display, scope: target.scope };
}

export async function getDomainKeywordSuggestions(
  ctx: Ctx, projectId: string,
  i: { domain: string; scope?: ResearchScope; locationCode?: number; languageCode?: string },
) {
  const m = labsMarket(ctx, projectId, i);
  const target = parseResearchTarget(i.domain, i.scope);
  const filters = rankedKeywordsScopeFilter(target);
  const r = await ctx.dfs.first<{ items?: RankedItem[] | null }>("/v3/dataforseo_labs/google/ranked_keywords/live", {
    target: target.hostname, location_code: m.locationCode, language_code: m.languageCode, limit: 100,
    order_by: ["ranked_serp_element.serp_item.etv,desc"], ...(filters ? { filters } : {}),
  });
  const keywords = (r.result?.items ?? []).flatMap((it) => {
    const kd = it.keyword_data, se = it.ranked_serp_element?.serp_item ?? it.ranked_serp_element;
    const keyword = kd?.keyword ?? it.keyword;
    if (!keyword) return [];
    return [{
      keyword, position: se?.rank_absolute ?? null, searchVolume: kd?.keyword_info?.search_volume ?? null, traffic: se?.etv ?? null,
      cpc: kd?.keyword_info?.cpc ?? null, keywordDifficulty: kd?.keyword_properties?.keyword_difficulty ?? kd?.keyword_info?.keyword_difficulty ?? null,
    }];
  });
  return { keywords, target: target.display, scope: target.scope };
}

export async function findSerpCompetitors(
  ctx: Ctx, projectId: string,
  i: MarketArgs & {
    keywords: string[]; resultTypes?: string[]; excludeDomains?: string[]; includeSubdomains?: boolean;
    sortBy?: "visibility" | "traffic_estimate" | "avg_position" | "keyword_count"; limit?: number; offset?: number;
  },
) {
  const m = labsMarket(ctx, projectId, i);
  const r = await ctx.dfs.first<{ items?: Record<string, unknown>[] | null }>("/v3/dataforseo_labs/google/serp_competitors/live", {
    keywords: i.keywords, location_code: m.locationCode, language_code: m.languageCode,
    item_types: i.resultTypes ?? ["organic", "local_pack"], ...(i.includeSubdomains != null ? { include_subdomains: i.includeSubdomains } : {}),
    limit: i.limit ?? 50, ...(i.offset ? { offset: i.offset } : {}),
  });
  const excluded = (i.excludeDomains ?? []).map((d) => d.replace(/^www\./, "").toLowerCase());
  const kept = (r.result?.items ?? []).filter((it) => {
    const d = (typeof it.domain === "string" ? it.domain : "").replace(/^www\./, "").toLowerCase();
    return !excluded.some((x) => hostMatchesDomain(d, x));
  });
  const field = i.sortBy === "avg_position" ? "avg_position" : i.sortBy === "keyword_count" ? "keywords_count" : i.sortBy === "traffic_estimate" ? "etv" : "visibility";
  const dir = i.sortBy === "avg_position" ? 1 : -1;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const competitors = [...kept].sort((a, b) => (n(a[field]) - n(b[field])) * dir);
  return { competitors };
}

export { AppError };
