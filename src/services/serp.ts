import type { Ctx } from "../ctx.ts";
import { AppError } from "../errors.ts";
import { getProject } from "./projects.ts";
import { isoCountryCode, resolveMarket, type Market } from "./markets.ts";
import { serpLocationsForCountry } from "./keywords.ts";

export const SERP_ANALYSIS_DEPTH = 20;

export type SerpItem = {
  type: string | null; rank: number | null; title: string | null; url: string | null; domain: string | null; description: string | null;
};
type RawItem = { type?: string; rank_group?: number; rank_absolute?: number; title?: string; url?: string; domain?: string; description?: string };

/** Live Google SERP rows, trimmed to the essentials; non-organic features keep their type with null fields. */
export async function fetchSerp(
  ctx: Ctx,
  q: { keyword: string; market: Market; depth: number; device?: "desktop" | "mobile"; locationName?: string; ignoreSnippetTypes?: boolean },
): Promise<{ items: SerpItem[]; costUsd: number }> {
  const r = await ctx.dfs.first<{ items?: RawItem[] | null }>("/v3/serp/google/organic/live/advanced", {
    keyword: q.keyword, ...(q.locationName ? { location_name: q.locationName } : { location_code: q.market.locationCode }),
    language_code: q.market.languageCode, depth: q.depth, device: q.device ?? "desktop",
  });
  const items = (r.result?.items ?? []).slice(0, q.depth).map((it) => ({
    type: it.type ?? null, rank: it.rank_absolute ?? it.rank_group ?? null, title: it.title ?? null, url: it.url ?? null,
    domain: it.domain ?? null, description: it.description ?? null,
  }));
  return { items, costUsd: r.costUsd };
}

export async function getSerpResults(
  ctx: Ctx, projectId: string,
  input: { queries: { keyword: string; locationCode?: number; languageCode?: string; locationName?: string }[]; depth?: number },
) {
  const project = getProject(ctx, projectId);
  const depth = input.depth ?? SERP_ANALYSIS_DEPTH;
  const results = await Promise.all(input.queries.map(async (q) => {
    try {
      const market = resolveMarket(q, project);
      if (q.locationName) await assertLocalLocation(ctx, market, q.locationName);
      const { items } = await fetchSerp(ctx, { keyword: q.keyword, market, depth, locationName: q.locationName });
      return { keyword: q.keyword, ok: true as const, items };
    } catch (e) {
      if (e instanceof AppError && (e.code === "NOT_CONFIGURED" || e.code === "UNAUTHENTICATED")) throw e;
      return { keyword: q.keyword, ok: false as const, error: (e as Error).message };
    }
  }));
  return { results };
}

async function assertLocalLocation(ctx: Ctx, m: Market, locationName: string) {
  const all = await serpLocationsForCountry(ctx, isoCountryCode(m.locationCode));
  if (all.some((l) => l.location_name === locationName)) return;
  throw new AppError("VALIDATION_ERROR", `No city, county or region called "${locationName.split(",").map((s) => s.trim()).join(", ")}" exists in this country. Use search_serp_locations to find the exact name.`);
}

export async function searchSerpLocations(ctx: Ctx, input: { query: string; countryCode: string }) {
  const iso = input.countryCode.trim();
  if (!/^[A-Za-z]{2}$/.test(iso)) throw new AppError("VALIDATION_ERROR", "countryCode must be a two-letter country code such as US");
  const all = await serpLocationsForCountry(ctx, iso);
  const q = input.query.trim().toLowerCase();
  const locations = all
    .filter((l) => l.location_name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.location_name.toLowerCase().startsWith(q)) - Number(a.location_name.toLowerCase().startsWith(q)) || a.location_name.length - b.location_name.length)
    .slice(0, 25)
    .map((l) => ({ locationName: l.location_name, locationCode: l.location_code, locationType: l.location_type }));
  return { locations };
}
