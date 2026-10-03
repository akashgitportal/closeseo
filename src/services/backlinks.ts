import type { Ctx } from "../ctx.ts";
import { getProject } from "./projects.ts";
import { escapeLike, joinFilters, parseResearchTarget, type ResearchScope, type ResearchTarget } from "./researchScope.ts";

type ScopeIn = ResearchScope | "page";
const SPAM_THRESHOLD = 40;
const REFERRING_PAGE_SIZE = 100;

/** Backlinks API addressing: what to send as `target`, whether subdomains count, and any URL filter. */
function apiTarget(t: ResearchTarget) {
  if (t.scope === "exact_url") return { target: `${t.urlHostname}${t.path}`, includeSubdomains: false, urlFilter: undefined as unknown[] | undefined };
  if (t.scope === "subfolder") {
    const p = escapeLike(t.path);
    const f = (host: string) => [["url_to", "like", `%://${host}${p}`], "or", ["url_to", "like", `%://${host}${p}/%`]];
    return { target: t.hostname, includeSubdomains: false, urlFilter: [f(t.hostname), "or", f(`www.${t.hostname}`)] };
  }
  return { target: t.hostname, includeSubdomains: t.scope === "subdomains", urlFilter: undefined };
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const parse = (target: string, scope?: ScopeIn) => parseResearchTarget(target, scope === "page" ? "exact_url" : scope);

export async function getBacklinksOverview(ctx: Ctx, projectId: string, i: { target: string; scope?: ScopeIn; hideSpam?: boolean }) {
  getProject(ctx, projectId);
  const t = parse(i.target, i.scope);
  const a = apiTarget(t);
  const hideSpam = i.hideSpam ?? true;
  const spamFilter = hideSpam ? ["backlink_spam_score", "<", 50] : undefined;
  const unavailable: string[] = [];
  let summary: Record<string, unknown>;
  let trends: { date: string | null; backlinks: number | null; referringDomains: number | null; rank: number | null }[] = [];
  let newLost: { date: string | null; newBacklinks: number | null; lostBacklinks: number | null; newReferringDomains: number | null; lostReferringDomains: number | null }[] = [];

  if (t.scope === "subfolder") {
    // No prefix targeting in the API: totals come from filtered backlink queries.
    const base = { target: a.target, include_subdomains: false, backlinks_status_type: "live", limit: 1 };
    const [links, domains] = await Promise.all([
      ctx.dfs.first<{ total_count?: number }>("/v3/backlinks/backlinks/live", { ...base, mode: "as_is", filters: a.urlFilter }),
      ctx.dfs.first<{ total_count?: number }>("/v3/backlinks/backlinks/live", { ...base, mode: "one_per_domain", filters: a.urlFilter }),
    ]);
    summary = { backlinks: links.result?.total_count ?? null, referring_domains: domains.result?.total_count ?? null };
  } else {
    // Settled, not all: the summary is billed on its own, so a failing trend call must not throw it away.
    const [sr, hr] = await Promise.allSettled([
      ctx.dfs.first<Record<string, unknown>>("/v3/backlinks/summary/live", { target: a.target, include_subdomains: a.includeSubdomains, backlinks_status_type: "live", ...(spamFilter ? { backlinks_filters: spamFilter } : {}) }),
      // history has no include_subdomains, so the trend series always include subdomains.
      ctx.dfs.first<{ items?: Record<string, unknown>[] | null }>("/v3/backlinks/history/live", { target: t.hostname }),
    ]);
    if (sr.status === "rejected") throw sr.reason;
    summary = sr.value.result ?? {};
    if (hr.status === "rejected") unavailable.push(`trend history (${(hr.reason as Error).message})`);
    for (const it of hr.status === "fulfilled" ? (hr.value.result?.items ?? []) : []) {
      const date = typeof it.date === "string" ? it.date : null;
      trends.push({ date, backlinks: num(it.backlinks), referringDomains: num(it.referring_domains), rank: num(it.rank) });
      newLost.push({ date, newBacklinks: num(it.new_backlinks), lostBacklinks: num(it.lost_backlinks), newReferringDomains: num(it.new_referring_domains), lostReferringDomains: num(it.lost_referring_domains) });
    }
  }
  const fetchedAt = new Date().toISOString();
  const overview = {
    overview: {
      target: t.hostname, displayTarget: t.display, scope: t.scope,
      summary: {
        rank: num(summary.rank), backlinks: num(summary.backlinks), referringPages: num(summary.referring_pages), referringDomains: num(summary.referring_domains),
        brokenBacklinks: num(summary.broken_backlinks), brokenPages: num(summary.broken_pages), backlinksSpamScore: num(summary.backlinks_spam_score),
        targetSpamScore: num(summary.target_spam_score), newBacklinks: null, lostBacklinks: null, newReferringDomains: null, lostReferringDomains: null,
      },
      trends, newLostTrends: newLost, fetchedAt,
    },
  };
  let referringDomains: Record<string, unknown> | undefined;
  if (t.scope !== "subfolder") {
    try {
    const r = await ctx.dfs.first<{ total_count?: number | null; items?: Record<string, unknown>[] | null }>("/v3/backlinks/referring_domains/live", {
      target: a.target, include_subdomains: a.includeSubdomains, limit: REFERRING_PAGE_SIZE, offset: 0, order_by: ["backlinks,desc"], backlinks_status_type: "live",
      ...(hideSpam ? { filters: ["backlinks_spam_score", "<", SPAM_THRESHOLD] } : {}),
    });
    const rows = (r.result?.items ?? []).map((d) => ({
      domain: (d.domain as string) ?? null, backlinks: num(d.backlinks), referringPages: num(d.referring_pages), rank: num(d.rank), spamScore: num(d.backlinks_spam_score),
      firstSeen: (d.first_seen as string) ?? null, brokenBacklinks: num(d.broken_backlinks), brokenPages: num(d.broken_pages),
    }));
    const total = r.result?.total_count ?? null;
    referringDomains = { rows, totalCount: total, hasMore: total !== null ? REFERRING_PAGE_SIZE < total : rows.length === REFERRING_PAGE_SIZE, page: 1, pageSize: REFERRING_PAGE_SIZE, fetchedAt };
    } catch (e) { unavailable.push(`referring-domain breakdown (${(e as Error).message})`); }
  }
  const scopeNote =
    t.scope === "domain" ? "Summary excludes subdomains; trend data includes subdomains (provider limitation)."
    : t.scope === "subfolder" ? "Counts are computed from filtered backlink totals; rank, trends, and the referring-domains breakdown aren't available for subfolders."
    : undefined;
  // Say what is missing instead of failing the whole overview after the summary was already paid for.
  const partial = unavailable.length ? `Some details were unavailable and are omitted: ${unavailable.join("; ")}. Run the overview again to fill them in.` : undefined;
  const note = [scopeNote, partial].filter(Boolean).join(" ") || undefined;
  return { target: t.display, scope: t.scope, ...(note ? { scopeNote: note } : {}), overview, ...(referringDomains ? { referringDomains } : {}) };
}

const SORT_MAP = { rank: "rank", domainRank: "domain_from_rank", spamScore: "backlink_spam_score", firstSeen: "first_seen" } as const;

export async function getBacklinksProfile(
  ctx: Ctx, projectId: string,
  i: {
    target: string; scope?: ScopeIn; page?: number; pageSize?: number; sortField?: keyof typeof SORT_MAP; sortOrder?: "asc" | "desc";
    filters?: {
      include?: string; exclude?: string; minDomainRank?: number | string; maxDomainRank?: number | string; minLinkAuthority?: number | string;
      maxLinkAuthority?: number | string; minSpamScore?: number | string; maxSpamScore?: number | string; linkType?: "dofollow" | "nofollow";
      hideLost?: boolean; hideBroken?: boolean; domainFrom?: string;
    };
    mode?: "one_per_domain" | "as_is"; hideSpam?: boolean;
  },
) {
  getProject(ctx, projectId);
  const t = parse(i.target, i.scope);
  const a = apiTarget(t);
  const page = Math.max(1, i.page ?? 1);
  const pageSize = i.pageSize ?? 50;
  const f = i.filters ?? {};
  const n = (v: number | string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  const cond = (field: string, op: string, v: unknown) => (v === undefined || (typeof v === "number" && Number.isNaN(v)) ? null : [field, op, v]);
  const clauses: (unknown[] | null)[] = [
    a.urlFilter ?? null,
    cond("domain_from_rank", ">=", n(f.minDomainRank)), cond("domain_from_rank", "<=", n(f.maxDomainRank)),
    cond("rank", ">=", n(f.minLinkAuthority)), cond("rank", "<=", n(f.maxLinkAuthority)),
    cond("backlink_spam_score", ">=", n(f.minSpamScore)), cond("backlink_spam_score", "<=", n(f.maxSpamScore)),
    f.linkType ? ["dofollow", "=", f.linkType === "dofollow"] : null,
    f.hideLost ? ["is_lost", "=", false] : null, f.hideBroken ? ["is_broken", "=", false] : null,
    f.include ? ["url_from", "ilike", `%${f.include}%`] : null, f.exclude ? ["url_from", "not_ilike", `%${f.exclude}%`] : null,
    f.domainFrom ? ["domain_from", "=", f.domainFrom.toLowerCase()] : null,
    // Unknown spam scores stay visible: only links known to be spammy are hidden.
    (i.hideSpam ?? true) ? [["backlink_spam_score", "<", SPAM_THRESHOLD], "or", ["backlink_spam_score", "=", null]] : null,
  ];
  const filters = joinFilters(clauses);
  const r = await ctx.dfs.first<{ total_count?: number | null; items?: Record<string, any>[] | null }>("/v3/backlinks/backlinks/live", {
    target: a.target, mode: i.mode ?? "one_per_domain", include_subdomains: a.includeSubdomains, limit: pageSize, offset: (page - 1) * pageSize,
    order_by: [`${SORT_MAP[i.sortField ?? "firstSeen"]},${i.sortOrder ?? "desc"}`], backlinks_status_type: "all", ...(filters ? { filters } : {}),
  });
  const items = r.result?.items ?? [];
  const totalCount = r.result?.total_count ?? null;
  const rows = items.map((b) => ({
    domainFrom: b.domain_from ?? null, urlFrom: b.url_from ?? null, urlTo: b.url_to ?? null, anchor: b.anchor ?? null, itemType: b.item_type ?? null,
    isDofollow: b.dofollow ?? null, relAttributes: Array.isArray(b.attributes) ? b.attributes : [], rank: num(b.rank), domainFromRank: num(b.domain_from_rank),
    pageFromRank: num(b.page_from_rank), spamScore: num(b.backlink_spam_score), firstSeen: b.first_seen ?? null, lastSeen: b.last_seen ?? null,
    isLost: b.is_lost ?? false, isBroken: b.is_broken ?? false, linksCount: num(b.links_count),
  }));
  return {
    target: t.display, scope: t.scope,
    backlinks: { rows, totalCount, hasMore: totalCount !== null ? page * pageSize < totalCount : items.length === pageSize, page, pageSize, fetchedAt: new Date().toISOString() },
  };
}
