import { Parser } from "htmlparser2";
import { analyzeHtml, type PageAnalysis } from "./analyze.ts";
import type { Fetcher, FetchResult } from "./fetcher.ts";
import { pageIssues, siteIssues, makeIssue, type Issue } from "./issues.ts";
import { ALLOW_ALL, parseRobots, type Robots } from "./robots.ts";

export type FetchClass = "ok" | "blocked" | "rate_limited" | "error";

export type CrawledPage = {
  url: string;
  statusCode: number | null;
  fetchClass: FetchClass;
  title: string | null;
  metaDescription: string | null;
  h1Count: number | null;
  wordCount: number | null;
  canonical: string | null;
  noindex: boolean;
  responseMs: number | null;
  depth: number;
  issues: Issue[];
};

export type CrawlOutput = { pages: CrawledPage[]; siteLevel: { url: string; issue: Issue }[] };

const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|pdf|zip|gz|tar|rar|7z|mp[34]|mov|avi|wmv|woff2?|ttf|eot|otf|css|js|mjs|json|xml|txt|docx?|xlsx?|pptx?|dmg|exe|apk)(\?.*)?$/i;

export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch {
    return null;
  }
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");
export const sameSite = (a: string, b: string) => bareHost(new URL(a).host) === bareHost(new URL(b).host);

function classify(r: FetchResult): FetchClass {
  if (r.status === null) return "error";
  if (r.status === 429) return "rate_limited";
  if (r.status === 401 || r.status === 403) return "blocked";
  if (r.status >= 500) return "error";
  return "ok";
}

/** Extract <loc> entries from a sitemap or sitemap index. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const urls: string[] = [], sitemaps: string[] = [];
  let inLoc = false, isIndex = false, buf = "";
  const p = new Parser({
    onopentag(n) { if (n === "sitemapindex") isIndex = true; if (n === "loc") { inLoc = true; buf = ""; } },
    ontext(t) { if (inLoc) buf += t; },
    onclosetag(n) {
      if (n !== "loc") return;
      inLoc = false;
      const v = buf.trim();
      if (v) (isIndex ? sitemaps : urls).push(v);
    },
  }, { xmlMode: true });
  p.write(xml);
  p.end();
  return { urls, sitemaps };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function crawlSite(opts: {
  startUrl: string;
  maxPages: number;
  fetcher: Fetcher;
  signal?: AbortSignal;
  concurrency?: number;
  delayMs?: number;
  onPage?: (page: CrawledPage, crawled: number) => void | Promise<void>;
}): Promise<CrawlOutput> {
  const start = normalizeUrl(opts.startUrl)!;
  const origin = new URL(start).origin;
  const concurrency = opts.concurrency ?? 4;
  const signal = opts.signal;

  // robots.txt and sitemaps
  const robotsRes = await opts.fetcher(`${origin}/robots.txt`, signal);
  const robotsOk = robotsRes.status !== null && robotsRes.status >= 200 && robotsRes.status < 300 && robotsRes.body !== null && !/<html/i.test(robotsRes.body.slice(0, 500));
  const robots: Robots = robotsOk ? parseRobots(robotsRes.body!) : ALLOW_ALL;
  const delay = Math.max(opts.delayMs ?? 100, Math.min(robots.crawlDelayMs ?? 0, 10_000));
  const siteLevel: { url: string; issue: Issue }[] = [];
  if (!robotsOk) siteLevel.push({ url: `${origin}/robots.txt`, issue: makeIssue("robots_txt_missing") });

  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  const seen = new Set<string>([start]);
  const enqueue = (raw: string, depth: number, base?: string) => {
    const u = normalizeUrl(raw, base);
    if (!u || seen.has(u) || !sameSite(u, start) || SKIP_EXT.test(new URL(u).pathname)) return;
    seen.add(u);
    queue.push({ url: u, depth });
  };

  const sitemapQueue = [...new Set([...robots.sitemaps, `${origin}/sitemap.xml`])];
  let sitemapFiles = 0, sitemapFound = false, sitemapUrls = 0;
  while (sitemapQueue.length && sitemapFiles < 10 && !signal?.aborted) {
    const sm = sitemapQueue.shift()!;
    sitemapFiles++;
    const r = await opts.fetcher(sm, signal);
    if (r.status === null || r.status >= 400 || !r.body || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
    sitemapFound = true;
    const parsed = parseSitemap(r.body);
    sitemapQueue.push(...parsed.sitemaps);
    for (const u of parsed.urls) if (sitemapUrls++ < 5000) enqueue(u, 1);
  }
  if (!sitemapFound) siteLevel.push({ url: `${origin}/sitemap.xml`, issue: makeIssue("sitemap_missing") });

  const pages: CrawledPage[] = [];
  const extra = new Map<string, { internalLinks: string[] }>();
  let active = 0;
  let lastStart = 0;

  const crawlOne = async (job: { url: string; depth: number }) => {
    const u = new URL(job.url);
    let page: CrawledPage;
    if (!robots.isAllowed(u.pathname + u.search)) {
      page = { url: job.url, statusCode: null, fetchClass: "blocked", title: null, metaDescription: null, h1Count: null, wordCount: null, canonical: null, noindex: false, responseMs: null, depth: job.depth, issues: [makeIssue("blocked_by_robots")] };
      extra.set(job.url, { internalLinks: [] });
    } else {
      const r = await opts.fetcher(job.url, signal);
      let html: PageAnalysis | null = null;
      if (r.body !== null && r.contentType && /html/i.test(r.contentType) && r.status !== null && r.status < 400) html = analyzeHtml(r.body);
      const issues = r.redirectLoop ? [makeIssue("redirect_loop", r.error ?? undefined)] : pageIssues({ url: job.url, finalUrl: r.finalUrl, status: r.status, responseMs: r.ms, redirects: r.redirects, html });
      page = {
        url: job.url, statusCode: r.status, fetchClass: r.redirectLoop ? "error" : classify(r),
        title: html?.title ?? null, metaDescription: html?.metaDescription ?? null, h1Count: html?.h1Count ?? null,
        wordCount: html?.wordCount ?? null, canonical: html?.canonical ?? null, noindex: html?.noindex ?? false,
        responseMs: r.ms, depth: job.depth, issues,
      };
      const links: string[] = [];
      if (html && !html.nofollow) {
        for (const l of html.links) {
          if ((l.rel ?? "").toLowerCase().includes("nofollow")) continue;
          const n = normalizeUrl(l.href, r.finalUrl);
          if (n && sameSite(n, start)) { links.push(n); enqueue(n, job.depth + 1); }
        }
      }
      extra.set(job.url, { internalLinks: links });
    }
    pages.push(page);
    await opts.onPage?.(page, pages.length);
  };

  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (signal?.aborted) { if (active === 0) resolve(); return; }
      while (active < concurrency && queue.length && pages.length + active < opts.maxPages) {
        const job = queue.shift()!;
        active++;
        const wait = Math.max(0, lastStart + delay - Date.now());
        lastStart = Date.now() + wait;
        sleep(wait).then(() => crawlOne(job)).then(() => { active--; pump(); }, (e) => { active--; reject(e); });
      }
      if (active === 0 && (queue.length === 0 || pages.length >= opts.maxPages)) resolve();
    };
    pump();
  });

  const bySite = siteIssues(pages.map((p) => ({ url: p.url, status: p.statusCode, title: p.title, metaDescription: p.metaDescription, internalLinks: extra.get(p.url)?.internalLinks ?? [] })));
  for (const s of bySite) pages.find((p) => p.url === s.url)?.issues.push(s.issue);
  return { pages, siteLevel };
}
