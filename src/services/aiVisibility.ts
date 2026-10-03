import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Ctx } from "../ctx.ts";
import { newId, nowIso } from "../db.ts";
import { hostOfUrl } from "../domain-utils.ts";
import { AppError } from "../errors.ts";
import { parseResearchTarget, RESEARCH_SCOPES, type ResearchScope, type ResearchTarget } from "./researchScope.ts";
import { getProject } from "./projects.ts";
import { isSupportedLanguageCode } from "./markets.ts";
import { withUsage } from "./usage.ts";

/**
 * AI visibility. Prompt Explorer puts one question to several assistants; Brand Lookup counts how often AI search
 * mentions or cites a brand or domain. Both use DataForSEO's ai_optimization endpoints.
 */

const require = createRequire(import.meta.url);
const countries = require("../data/web-search-countries.json") as { all: string[]; claude: string[] };

export const MODELS = ["chat_gpt", "claude", "gemini", "perplexity"] as const;
export type Model = (typeof MODELS)[number];
export const MODEL_LABELS: Record<Model, string> = { chat_gpt: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity" };
export const PROMPT_MAX = 500;
export const BRAND_MAX = 250;
const MAX_COMPETITORS = 5;
const MAX_OUTPUT_TOKENS = 4096; // reasoning models burn part of this limit on hidden thinking
const PROMPT_TTL_MS = 7 * 86_400_000;
const BRAND_TTL_MS = 86_400_000;
const CATALOG_TTL_MS = 3_600_000;
const CHATGPT_LOCATION = 2840;
const CHATGPT_LANGUAGE = "en";

const WEB_COUNTRIES: Record<Model, ReadonlySet<string>> = {
  chat_gpt: new Set(countries.all), claude: new Set(countries.claude), gemini: new Set(), perplexity: new Set(countries.all),
};
export const supportsWebSearchCountry = (m: Model, c: string) => WEB_COUNTRIES[m].has(c);
export const webSearchCountries = () => ({ all: countries.all, claude: countries.claude, gemini: [] as string[] });

// ---------------- model catalog ----------------

const FALLBACK: Record<Model, string[]> = {
  chat_gpt: ["gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5"],
  claude: ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"],
  gemini: ["gemini-2.5-pro"],
  perplexity: ["sonar-reasoning-pro", "sonar-pro", "sonar"],
};
const PINNED: Partial<Record<Model, string>> = { chat_gpt: "gpt-5.6-luna" };
const LATEST: Record<Model, RegExp> = {
  chat_gpt: /^gpt-(\d+(?:\.\d+)*)$/, claude: /^claude-sonnet-(\d+(?:-\d+)*)$/, gemini: /^gemini-(\d+(?:\.\d+)*)-pro$/, perplexity: /^sonar-reasoning-pro$/,
};
const catalog = new Map<string, { names: string[]; at: number }>();

function versionCompare(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; }
  return 0;
}

export function pickLatestModel(model: Model, names: string[]): string {
  const pinned = PINNED[model];
  if (pinned && names.includes(pinned)) return pinned;
  let best: { name: string; v: number[] } | null = null;
  for (const name of names) {
    const m = LATEST[model].exec(name);
    if (!m) continue;
    const v = (m[1] ?? "0").split(/[.-]/).map(Number);
    if (!best || versionCompare(v, best.v) > 0) best = { name, v };
  }
  return best?.name ?? FALLBACK[model].find((n) => names.includes(n)) ?? FALLBACK[model][0]!;
}

async function modelNames(ctx: Ctx, model: Model): Promise<string[]> {
  const key = `${ctx.config.dataforseoBaseUrl}|${model}`;
  const hit = catalog.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.names;
  try {
    const r = await ctx.dfs.request<{ model_name?: string }[]>(`/v3/ai_optimization/${model}/llm_responses/models`);
    const names = (r.result ?? []).flatMap((x) => (typeof x?.model_name === "string" ? [x.model_name] : []));
    if (!names.length) return FALLBACK[model];
    catalog.set(key, { names, at: Date.now() });
    return names;
  } catch (e) {
    if (e instanceof AppError && ["UNAUTHENTICATED", "NOT_CONFIGURED", "BUDGET_EXCEEDED"].includes(e.code)) throw e;
    return FALLBACK[model];
  }
}

/** Which model will answer for each provider, according to DataForSEO's current catalogue. */
export async function listModels(ctx: Ctx) {
  return Promise.all(MODELS.map(async (m) => ({ model: m, label: MODEL_LABELS[m], modelName: pickLatestModel(m, await modelNames(ctx, m)), webSearchCountries: m === "gemini" ? 0 : WEB_COUNTRIES[m].size })));
}

// ---------------- shared helpers ----------------

const isHttpUrl = (v: unknown): v is string => {
  if (typeof v !== "string" || !v) return false;
  try { const u = new URL(v); return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password; } catch { return false; }
};
const hostname = (v: string) => hostOfUrl(v);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const trunc = (v: string, n: number) => (v.length <= n ? v : v.slice(0, n));
const sha = (o: unknown) => createHash("sha256").update(JSON.stringify(o)).digest("hex");
const ACCOUNT_LEVEL = new Set(["UPSTREAM_BILLING", "UPSTREAM_PAUSED", "BUDGET_EXCEEDED", "NOT_CONFIGURED", "UNAUTHENTICATED"]);
const isAccountLevel = (e: unknown) => e instanceof AppError && ACCOUNT_LEVEL.has(e.code);

function cacheGet<T>(ctx: Ctx, key: string): T | null {
  const r = ctx.db.prepare("SELECT payload, expires_at FROM ai_cache WHERE key=?").get(key) as { payload: string; expires_at: string } | undefined;
  if (!r || r.expires_at <= nowIso()) return null;
  try { return JSON.parse(r.payload) as T; } catch { return null; }
}
function cacheSet(ctx: Ctx, key: string, kind: string, value: unknown, ttlMs: number) {
  ctx.db.prepare("DELETE FROM ai_cache WHERE expires_at<=?").run(nowIso());
  ctx.db.prepare("INSERT INTO ai_cache (key,kind,payload,created_at,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at, expires_at=excluded.expires_at")
    .run(key, kind, JSON.stringify(value), nowIso(), new Date(Date.now() + ttlMs).toISOString());
}

// ---------------- prompt explorer ----------------

export type Citation = { url: string; domain: string | null; title: string | null; matchedBrand: boolean };
export type ModelResult =
  | { status: "success"; model: Model; modelName: string | null; text: string; citations: Citation[]; fanOutQueries: string[]; brandMentioned: boolean | null; outputTokens: number | null; webSearch: boolean; webSearchCountryCode: string | null; cached: boolean }
  | { status: "error"; model: Model; errorCode: "UNSUPPORTED_COUNTRY" | "UPSTREAM_ERROR"; message: string };
export type PromptResult = { id: string; prompt: string; highlightBrand: string | null; fetchedAt: string; costUsd: number; results: ModelResult[] };
export type PromptInput = { prompt: string; models: Model[]; highlightBrand?: string; webSearch?: boolean; webSearchCountryCode?: string };

type RawResponse = {
  model_name?: string | null; output_tokens?: number | null; web_search?: boolean | null; fan_out_queries?: string[] | null;
  items?: { type?: string | null; sections?: { text?: string | null; annotations?: { title?: string | null; url?: string | null }[] | null }[] | null }[] | null;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Case-insensitive match that applies a word boundary only on edges that are word characters, so "C++" is not found inside "C+++". */
function mentionRegex(brand: string) {
  const lead = /^\w/.test(brand) ? "\\b" : `(?<!${esc(brand[0]!)})`;
  const trail = /\w$/.test(brand) ? "\\b" : `(?!${esc(brand[brand.length - 1]!)})`;
  return new RegExp(`${lead}${esc(brand)}${trail}`, "i");
}

export function extractCitations(r: RawResponse): Omit<Citation, "matchedBrand">[] {
  const seen = new Set<string>();
  const out: Omit<Citation, "matchedBrand">[] = [];
  for (const item of r.items ?? []) {
    if (item.type !== "message") continue;
    for (const sec of item.sections ?? []) for (const a of sec.annotations ?? []) {
      if (!isHttpUrl(a.url) || seen.has(a.url)) continue; // model output cannot be trusted, so javascript: and data: links are dropped
      seen.add(a.url);
      out.push({ url: a.url, domain: hostname(a.url), title: typeof a.title === "string" ? a.title : null });
    }
  }
  return out.slice(0, 25);
}

function applyBrand(res: Extract<ModelResult, { status: "success" }>, brand: string | null) {
  const needle = brand?.toLowerCase() ?? null;
  const citations = res.citations.map((c) => ({ ...c, matchedBrand: needle ? `${c.url} ${c.title ?? ""}`.toLowerCase().includes(needle) : false }));
  const brandMentioned = brand === null ? null : citations.some((c) => c.matchedBrand) || mentionRegex(brand).test(res.text);
  return { ...res, citations, brandMentioned };
}

export function validatePromptInput(raw: Record<string, unknown>): Required<Pick<PromptInput, "prompt" | "models" | "webSearch">> & { highlightBrand: string | null; country: string | null } {
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) throw new AppError("VALIDATION_ERROR", "Write a prompt to send to the models");
  if (prompt.length > PROMPT_MAX) throw new AppError("VALIDATION_ERROR", `The prompt is ${prompt.length} characters, above the ${PROMPT_MAX} limit.`);
  if (!Array.isArray(raw.models) || raw.models.length < 1 || raw.models.length > 4 || raw.models.some((m) => !(MODELS as readonly unknown[]).includes(m)))
    throw new AppError("VALIDATION_ERROR", `Pick between one and four models out of: ${MODELS.join(", ")}`);
  const brandRaw = raw.highlightBrand === undefined || raw.highlightBrand === null ? "" : raw.highlightBrand;
  if (typeof brandRaw !== "string") throw new AppError("VALIDATION_ERROR", "highlightBrand has to be text");
  const highlightBrand = brandRaw.trim() || null;
  if (highlightBrand && highlightBrand.length > BRAND_MAX) throw new AppError("VALIDATION_ERROR", `That brand name exceeds ${BRAND_MAX} characters.`);
  if (raw.webSearch !== undefined && typeof raw.webSearch !== "boolean") throw new AppError("VALIDATION_ERROR", "webSearch has to be true or false");
  const c = raw.webSearchCountryCode;
  if (c !== undefined && c !== null && c !== "default" && (typeof c !== "string" || !WEB_COUNTRIES.chat_gpt.has(c)))
    throw new AppError("VALIDATION_ERROR", "webSearchCountryCode has to be a two-letter country code like US");
  return { prompt, models: [...new Set(raw.models as Model[])], highlightBrand, webSearch: raw.webSearch !== false, country: typeof c === "string" && c !== "default" ? c : null };
}

export async function explorePrompt(ctx: Ctx, projectId: string, raw: Record<string, unknown>): Promise<PromptResult> {
  getProject(ctx, projectId);
  if (!ctx.dfs.configured) throw new AppError("NOT_CONFIGURED", "AI visibility needs a DataForSEO key, and DATAFORSEO_API_KEY is empty.");
  const input = validatePromptInput(raw);
  const meter = { usd: 0 };
  return withUsage({ projectId, feature: "ai_visibility", meter }, async () => {
    const settled = await Promise.allSettled(input.models.map((m) => runModel(ctx, projectId, m, input)));
    const results: ModelResult[] = settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      if (isAccountLevel(s.reason)) throw s.reason; // this affects every model equally, so report it once
      console.error(`ai-visibility.prompt.${input.models[i]} failed:`, s.reason);
      return { status: "error", model: input.models[i]!, errorCode: "UPSTREAM_ERROR", message: "This model could not be reached just now; try again shortly." };
    });
    const out: PromptResult = { id: newId(), prompt: input.prompt, highlightBrand: input.highlightBrand, fetchedAt: nowIso(), costUsd: meter.usd, results };
    if (results.some((r) => r.status === "success")) saveRun(ctx, projectId, "prompt", input.prompt, out);
    return out;
  });
}

async function runModel(ctx: Ctx, projectId: string, model: Model, input: ReturnType<typeof validatePromptInput>): Promise<ModelResult> {
  const country = input.webSearch ? input.country : null;
  if (country && !supportsWebSearchCountry(model, country)) {
    const label = MODEL_LABELS[model];
    const why = model === "gemini" ? `${label} has no country setting for web search.` : `${label} cannot search from ${country}.`;
    return { status: "error", model, errorCode: "UNSUPPORTED_COUNTRY", message: `${why} Choose “Any country” and run it again if you want ${label} included.` };
  }
  const modelName = pickLatestModel(model, await modelNames(ctx, model));
  const key = sha({ projectId, model, modelName, prompt: input.prompt.replace(/\s+/g, " "), webSearch: input.webSearch, country, v: 7 });
  const hit = cacheGet<Extract<ModelResult, { status: "success" }>>(ctx, key);
  if (hit?.status === "success") return applyBrand({ ...hit, cached: true }, input.highlightBrand);

  const fetchOnce = async () => {
    const fields = {
      user_prompt: input.prompt, model_name: modelName, web_search: input.webSearch,
      ...(input.webSearch && model === "claude" ? { force_web_search: true } : {}),
      max_output_tokens: MAX_OUTPUT_TOKENS,
      ...(input.webSearch && country ? { web_search_country_iso_code: country } : {}),
    };
    const r = await ctx.dfs.first<RawResponse>(`/v3/ai_optimization/${model}/llm_responses/live`, fields);
    return r.result ?? ({} as RawResponse);
  };
  let raw = await fetchOnce();
  // Enabling web_search merely allows a search. Models that cannot be forced to search often reply from memory and cite nothing,
  // so one extra paid attempt is made; if that attempt fails, the first (already paid for) reply is kept.
  if (input.webSearch && !raw.web_search) {
    const retried = await fetchOnce().catch(() => null);
    if (retried?.web_search) raw = retried;
  }
  const text = (raw.items ?? []).filter((i) => i.type === "message").flatMap((i) => i.sections ?? [])
    .map((s) => s.text).filter((t): t is string => typeof t === "string" && t.length > 0).join("\n\n").trim();
  const shaped: Extract<ModelResult, { status: "success" }> = {
    status: "success", model, modelName: raw.model_name ?? null, text,
    citations: extractCitations(raw).map((c) => ({ ...c, matchedBrand: false })),
    fanOutQueries: (raw.fan_out_queries ?? []).filter((q) => typeof q === "string").slice(0, 20),
    brandMentioned: null, outputTokens: asNum(raw.output_tokens), webSearch: raw.web_search === true, webSearchCountryCode: country, cached: false,
  };
  cacheSet(ctx, key, "prompt", shaped, PROMPT_TTL_MS);
  return applyBrand(shaped, input.highlightBrand);
}

// ---------------- brand lookup ----------------

type Platform = "chat_gpt" | "google";
const PLATFORMS: Platform[] = ["chat_gpt", "google"];
type Group = { type?: string | null; key?: string | null; mentions?: number | null; ai_search_volume?: number | null };
type Mention = {
  question?: string | null; ai_search_volume?: number | null; first_response_at?: string | null; last_response_at?: string | null;
  sources?: { url?: string | null; title?: string | null }[] | null; monthly_searches?: { year: number; month: number; search_volume?: number | null }[] | null;
  brand_entities?: { title?: string | null }[] | null;
};
type TopPage = { key?: string | null; platform?: Group[] | null };
type Bundle = { aggregated: { platform?: Group[] | null }; topPages: TopPage[]; mentions: Mention[]; complete: boolean };
type Detected = { type: "domain" | "keyword"; value: string };

export function detectTarget(input: string): Detected {
  const t = input.trim();
  if (t && !/\s/.test(t) && t.includes(".")) {
    try { const h = parseResearchTarget(t, "subdomains").hostname; if (h.includes(".")) return { type: "domain", value: h }; } catch { /* a keyword such as "node.js" */ }
  }
  return { type: "keyword", value: t };
}

function llmTarget(d: Detected, includeSubdomains: boolean) {
  return d.type === "domain"
    ? { domain: d.value, include_subdomains: includeSubdomains, search_filter: "include", search_scope: ["any"] }
    : { keyword: d.value, search_filter: "include", search_scope: ["any", "brand_entities"], match_type: "word_match" };
}

export function urlMatchesTarget(url: string, t: ResearchTarget): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (t.scope === "subdomains" ? !(host === t.hostname || host.endsWith(`.${t.hostname}`)) : host !== t.hostname) return false;
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  if (t.scope === "exact_url") return path === t.path;
  if (t.scope === "subfolder") return path === t.path || path.startsWith(`${t.path}/`);
  return true;
}

const sum = (xs: (number | null)[]) => { let t = 0, any = false; for (const x of xs) if (x != null) { t += x; any = true; } return any ? t : null; };
const byDesc = <T,>(f: (x: T) => number) => (a: T, b: T) => f(b) - f(a);

export type BrandInput = { query: string; competitors?: string[]; scope?: ResearchScope; locationCode?: number; languageCode?: string };
export type BrandResult = {
  query: string; detectedTargetType: "domain" | "keyword"; resolvedTarget: string; scope: ResearchScope | null; aggregatesAreDomainLevel: boolean;
  fetchedAt: string; hasData: boolean; totalMentions: number | null; totalAiSearchVolume: number | null; cached: boolean; costUsd: number;
  perPlatform: { platform: Platform; status: "success" | "error"; mentions: number | null; aiSearchVolume: number | null }[];
  shareOfVoice: { platforms: Platform[]; entries: { label: string; isTarget: boolean; mentions: number | null; sharePct: number | null }[] } | null;
  topPages: { url: string; domain: string | null; platform: Platform; mentions: number | null; capturedVolume: number | null; keywords: { question: string; aiSearchVolume: number | null }[] }[];
  topQueries: { question: string; platform: Platform; aiSearchVolume: number | null; firstSeenAt: string | null; lastSeenAt: string | null; citedSources: { url: string; domain: string | null; title: string | null }[]; brandsMentioned: string[] }[];
  monthlyVolume: { year: number; month: number; volume: number }[];
};

function validateBrandInput(raw: Record<string, unknown>, project: { locationCode: number; languageCode: string }) {
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  if (!query) throw new AppError("VALIDATION_ERROR", "Type a brand, domain or keyword");
  if (query.length > BRAND_MAX) throw new AppError("VALIDATION_ERROR", `That brand name exceeds ${BRAND_MAX} characters.`);
  const compRaw = raw.competitors ?? [];
  if (!Array.isArray(compRaw) || compRaw.some((c) => typeof c !== "string")) throw new AppError("VALIDATION_ERROR", "competitors has to be a list of text entries");
  const competitors = compRaw.map((c: string) => c.trim()).filter(Boolean);
  if (competitors.some((c) => c.length > BRAND_MAX)) throw new AppError("VALIDATION_ERROR", `A competitor name exceeds ${BRAND_MAX} characters.`);
  if (new Set(competitors).size > MAX_COMPETITORS) throw new AppError("VALIDATION_ERROR", `No more than ${MAX_COMPETITORS} competitors can be compared at once.`);
  if (raw.scope !== undefined && raw.scope !== null && !(RESEARCH_SCOPES as readonly unknown[]).includes(raw.scope)) throw new AppError("VALIDATION_ERROR", `scope has to be one of ${RESEARCH_SCOPES.join(", ")}`);
  const loc = raw.locationCode ?? project.locationCode;
  if (typeof loc !== "number" || !Number.isInteger(loc) || loc <= 0) throw new AppError("VALIDATION_ERROR", "locationCode has to be a positive whole number");
  const lang = raw.languageCode ?? project.languageCode;
  if (typeof lang !== "string" || !isSupportedLanguageCode(lang)) throw new AppError("VALIDATION_ERROR", "Use a supported language code, for instance en");
  return { query, competitors, scope: (raw.scope ?? undefined) as ResearchScope | undefined, locationCode: loc, languageCode: lang };
}

export async function brandLookup(ctx: Ctx, projectId: string, raw: Record<string, unknown>): Promise<BrandResult> {
  const project = getProject(ctx, projectId);
  if (!ctx.dfs.configured) throw new AppError("NOT_CONFIGURED", "AI visibility needs a DataForSEO key, and DATAFORSEO_API_KEY is empty.");
  const input = validateBrandInput(raw, project);
  const detected = detectTarget(input.query);

  let research: ResearchTarget | null = null;
  if (detected.type === "domain") {
    try { research = parseResearchTarget(input.query, input.scope); } catch (e) { if (input.scope) throw e; }
  }
  const includeSubdomains = research === null || research.scope === "subdomains";
  const seen = new Set([detected.value.toLowerCase()]);
  const competitors: Detected[] = [];
  for (const c of input.competitors) {
    const d = detectTarget(c);
    if (seen.has(d.value.toLowerCase())) continue;
    seen.add(d.value.toLowerCase());
    competitors.push(d);
  }
  if (competitors.length > MAX_COMPETITORS) throw new AppError("VALIDATION_ERROR", `No more than ${MAX_COMPETITORS} competitors can be compared at once.`);

  const pageFilter = research && (research.scope === "exact_url" || research.scope === "subfolder") ? research : null;
  const resolvedTarget = research?.display ?? detected.value;
  const key = sha({ projectId, t: detected.type, v: detected.value.toLowerCase(), c: competitors.map((c) => c.value.toLowerCase()).sort(), loc: input.locationCode, lang: input.languageCode, scope: research?.scope ?? null, path: pageFilter?.path ?? "" });
  const hit = cacheGet<BrandResult>(ctx, key);
  if (hit) {
    const out = { ...hit, query: input.query, resolvedTarget, cached: true, costUsd: 0 };
    saveRun(ctx, projectId, "brand", input.query, out);
    return out;
  }

  const meter = { usd: 0 };
  return withUsage({ projectId, feature: "ai_visibility", meter }, async () => {
    const post = async <T,>(path: string, body: Record<string, unknown>) => (await ctx.dfs.first<{ items?: T[] | null; total?: T | null }>(path, body)).result;
    const where = (p: Platform) => ({ platform: p, location_code: p === "chat_gpt" ? CHATGPT_LOCATION : input.locationCode, language_code: p === "chat_gpt" ? CHATGPT_LANGUAGE : input.languageCode });
    const settle = async <T,>(f: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> => { try { return { ok: true, v: await f() }; } catch (e) { return { ok: false, e }; } };
    const target = [llmTarget(detected, includeSubdomains)];

    const bundles: { platform: Platform; status: "success" | "error"; bundle: Bundle | null }[] = [];
    for (const platform of PLATFORMS) {
      const w = where(platform);
      const agg = await settle(() => post<never>("/v3/ai_optimization/llm_mentions/aggregated_metrics/live", { target, ...w, internal_list_limit: 20 }));
      const top = await settle(() => post<TopPage>("/v3/ai_optimization/llm_mentions/top_pages/live", { target, ...w, links_scope: "sources", items_list_limit: 10, internal_list_limit: 5 }));
      const men = await settle(() => post<Mention>("/v3/ai_optimization/llm_mentions/search/live", { target, ...w, limit: 100 }));
      for (const r of [agg, top, men]) if (!r.ok && isAccountLevel(r.e)) throw r.e;
      if (!agg.ok && !top.ok && !men.ok) {
        const e = agg.e;
        if (isAccountLevel(e)) throw e;
        console.error(`ai-visibility.brand.${platform} failed:`, e);
        bundles.push({ platform, status: "error", bundle: null });
        continue;
      }
      bundles.push({
        platform, status: "success",
        bundle: {
          aggregated: agg.ok ? ((agg.v as { total?: { platform?: Group[] } }).total ?? {}) : {},
          topPages: top.ok ? ((top.v as { items?: TopPage[] }).items ?? []) : [], mentions: men.ok ? ((men.v as { items?: Mention[] }).items ?? []) : [],
          complete: agg.ok && top.ok && men.ok,
        },
      });
    }

    const cross: { platform: Platform; status: "success" | "error"; items: { key?: string | null; platform?: Group[] | null }[] }[] = [];
    if (competitors.length) {
      const groups = [{ key: detected.value, d: detected }, ...competitors.map((c) => ({ key: c.value, d: c }))];
      for (const platform of PLATFORMS) {
        const r = await settle(() => post<{ key?: string | null; platform?: Group[] | null }>("/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live", {
          targets: groups.map((g) => ({ aggregation_key: g.key, target: [llmTarget(g.d, includeSubdomains)] })), ...where(platform), internal_list_limit: 5,
        }));
        if (!r.ok) { if (isAccountLevel(r.e)) throw r.e; console.error(`ai-visibility.brand.${platform}.cross failed:`, r.e); cross.push({ platform, status: "error", items: [] }); continue; }
        cross.push({ platform, status: "success", items: (r.v as { items?: never[] }).items ?? [] });
      }
    }

    const result = shapeBrand({ query: input.query, detected, research, pageFilter, bundles, cross, competitorKeys: competitors.map((c) => c.value), loc: input.locationCode, lang: input.languageCode });
    result.costUsd = meter.usd;
    const complete = bundles.every((b) => b.status === "success" && b.bundle?.complete) && cross.every((c) => c.status === "success");
    if (complete && result.hasData) cacheSet(ctx, key, "brand", result, BRAND_TTL_MS);
    saveRun(ctx, projectId, "brand", input.query, result);
    return result;
  });
}

type ShapeArgs = {
  query: string; detected: Detected; research: ResearchTarget | null; pageFilter: ResearchTarget | null;
  bundles: { platform: Platform; status: "success" | "error"; bundle: Bundle | null }[];
  cross: { platform: Platform; status: "success" | "error"; items: { key?: string | null; platform?: Group[] | null }[] }[];
  competitorKeys: string[]; loc: number; lang: string;
};

export function shapeBrand(a: ShapeArgs): BrandResult {
  const ok = a.bundles.filter((b): b is typeof b & { bundle: Bundle } => b.status === "success" && b.bundle !== null);
  const chatGptMatches = a.loc === CHATGPT_LOCATION && a.lang.toLowerCase().split(/[-_]/)[0] === CHATGPT_LANGUAGE;
  // The ChatGPT figures only exist for US English, so for other markets they stay out of totals, trend and share of voice.
  const counted = (p: Platform) => chatGptMatches || p !== "chat_gpt";

  const perPlatform = a.bundles.map((b) => {
    if (b.status === "error" || !b.bundle) return { platform: b.platform, status: "error" as const, mentions: null, aiSearchVolume: null };
    const g = b.bundle.aggregated.platform?.find((e) => e.key === b.platform);
    return { platform: b.platform, status: "success" as const, mentions: asNum(g?.mentions), aiSearchVolume: asNum(g?.ai_search_volume) };
  });
  const totals = perPlatform.filter((p) => counted(p.platform));
  const totalMentions = sum(totals.map((p) => p.mentions));
  const totalAiSearchVolume = sum(totals.map((p) => p.aiSearchVolume));

  // cited sources: the most cited pages together with the questions that led to them
  const examples = new Map<string, Map<string, number | null>>();
  for (const b of ok) for (const m of b.bundle.mentions) {
    const q = typeof m.question === "string" ? trunc(m.question, 500) : "";
    if (!q) continue;
    for (const s of m.sources ?? []) {
      if (!isHttpUrl(s.url)) continue;
      const k = `${b.platform}::${s.url}`;
      const e = examples.get(k) ?? new Map();
      if (!e.has(q)) e.set(q, asNum(m.ai_search_volume));
      examples.set(k, e);
    }
  }
  const pageRows = ok.flatMap((b) => b.bundle.topPages.flatMap((p) => {
    const url = p.key;
    if (!isHttpUrl(url) || url.length > 2048) return [];
    if (a.pageFilter && !urlMatchesTarget(url, a.pageFilter)) return [];
    const g = p.platform?.find((e) => e.key === b.platform);
    const ex = examples.get(`${b.platform}::${url}`) ?? new Map<string, number | null>();
    return [{ url, domain: hostname(url), platform: b.platform, mentions: asNum(g?.mentions), capturedVolume: asNum(g?.ai_search_volume),
      keywords: [...ex].map(([question, aiSearchVolume]) => ({ question, aiSearchVolume })).sort(byDesc((k) => k.aiSearchVolume ?? 0)).slice(0, 50) }];
  }));
  const topPages = PLATFORMS.flatMap((p) => pageRows.filter((r) => r.platform === p).sort(byDesc((r) => r.capturedVolume ?? 0)).slice(0, 10))
    .sort((x, y) => (y.capturedVolume ?? 0) - (x.capturedVolume ?? 0) || (y.mentions ?? 0) - (x.mentions ?? 0));

  const topQueries = ok.flatMap((b) => b.bundle.mentions
    .filter((m): m is Mention & { question: string } => typeof m.question === "string" && m.question.length > 0)
    .filter((m) => !a.pageFilter || (m.sources ?? []).some((s) => isHttpUrl(s.url) && urlMatchesTarget(s.url, a.pageFilter!)))
    .map((m) => ({
      question: trunc(m.question, 500), platform: b.platform, aiSearchVolume: asNum(m.ai_search_volume), firstSeenAt: m.first_response_at ?? null, lastSeenAt: m.last_response_at ?? null,
      citedSources: (m.sources ?? []).flatMap((s) => (isHttpUrl(s.url) && s.url.length <= 2048 ? [{ url: s.url, domain: hostname(s.url), title: typeof s.title === "string" ? trunc(s.title, 300) : null }] : [])).slice(0, 10),
      brandsMentioned: (m.brand_entities ?? []).map((e) => e.title ?? "").filter(Boolean).map((t) => trunc(t, 200)).slice(0, 20),
    }))
    .sort(byDesc((q) => q.aiSearchVolume ?? 0)).slice(0, 25))
    .sort(byDesc((q) => q.aiSearchVolume ?? 0));

  const months = new Map<string, number>();
  for (const b of ok.filter((x) => counted(x.platform))) for (const m of b.bundle.mentions) for (const ms of m.monthly_searches ?? []) {
    if (ms.search_volume == null) continue;
    months.set(`${ms.year}-${ms.month}`, (months.get(`${ms.year}-${ms.month}`) ?? 0) + ms.search_volume);
  }
  const monthlyVolume = [...months].map(([k, v]) => { const [y, m] = k.split("-"); return { year: Number(y), month: Number(m), volume: Math.round(v) }; })
    .sort((x, y) => x.year - y.year || x.month - y.month).slice(-12);

  let shareOfVoice: BrandResult["shareOfVoice"] = null;
  const crossOk = a.cross.filter((c) => c.status === "success" && counted(c.platform));
  if (a.competitorKeys.length && crossOk.length) {
    const keys = [a.detected.value, ...a.competitorKeys];
    const label = new Map(keys.map((k) => [k.toLowerCase(), k]));
    const mentions = new Map<string, number | null>(keys.map((k) => [k.toLowerCase(), null]));
    for (const c of crossOk) for (const it of c.items) {
      if (it.key == null) continue;
      const k = it.key.toLowerCase();
      if (!label.has(k)) continue;
      mentions.set(k, sum([mentions.get(k) ?? null, sum((it.platform ?? []).map((e) => asNum(e.mentions)))]));
    }
    const denom = sum([...mentions.values()]) ?? 0;
    const entries = [...mentions].map(([k, m]) => ({ label: label.get(k) ?? k, isTarget: k === a.detected.value.toLowerCase(), mentions: m, sharePct: m == null || denom <= 0 ? null : (m / denom) * 100 }))
      .sort(byDesc((e) => e.mentions ?? -1));
    shareOfVoice = { platforms: crossOk.map((c) => c.platform), entries };
  }

  const hasData = (totalMentions ?? 0) > 0 || topPages.length > 0 || topQueries.length > 0 || monthlyVolume.length > 0 || (shareOfVoice?.entries.some((e) => e.mentions != null) ?? false);
  return {
    query: a.query, detectedTargetType: a.detected.type, resolvedTarget: a.research?.display ?? a.detected.value, scope: a.research?.scope ?? null,
    aggregatesAreDomainLevel: a.pageFilter !== null, fetchedAt: nowIso(), hasData, totalMentions, totalAiSearchVolume, cached: false, costUsd: 0,
    perPlatform, shareOfVoice, topPages, topQueries, monthlyVolume,
  };
}

// ---------------- history ----------------

function saveRun(ctx: Ctx, projectId: string, kind: "prompt" | "brand", query: string, payload: unknown) {
  try {
    ctx.db.prepare("INSERT INTO ai_runs (id,project_id,kind,query,payload,created_at) VALUES (?,?,?,?,?,?)").run(newId(), projectId, kind, trunc(query, 500), JSON.stringify(payload), nowIso());
    // retain only the 100 most recent runs for each project
    ctx.db.prepare("DELETE FROM ai_runs WHERE project_id=? AND id NOT IN (SELECT id FROM ai_runs WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100)").run(projectId, projectId);
  } catch (e) {
    // the project may have been removed while this ran; the result is still handed back
    console.warn("ai-visibility: could not save run", (e as Error).message);
  }
}

export function listRuns(ctx: Ctx, projectId: string, kind?: "prompt" | "brand") {
  getProject(ctx, projectId);
  const rows = (kind
    ? ctx.db.prepare("SELECT id, kind, query, created_at FROM ai_runs WHERE project_id=? AND kind=? ORDER BY created_at DESC, rowid DESC LIMIT 30").all(projectId, kind)
    : ctx.db.prepare("SELECT id, kind, query, created_at FROM ai_runs WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 30").all(projectId)) as { id: string; kind: string; query: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, query: r.query, createdAt: r.created_at }));
}

export function getRun(ctx: Ctx, projectId: string, runId: string) {
  const r = ctx.db.prepare("SELECT id, kind, payload FROM ai_runs WHERE id=? AND project_id=?").get(runId, projectId) as { id: string; kind: string; payload: string } | undefined;
  if (!r) throw new AppError("NOT_FOUND");
  return { id: r.id, kind: r.kind, result: JSON.parse(r.payload) as unknown };
}

export function deleteRun(ctx: Ctx, projectId: string, runId: string) {
  if (ctx.db.prepare("DELETE FROM ai_runs WHERE id=? AND project_id=?").run(runId, projectId).changes === 0) throw new AppError("NOT_FOUND");
}
