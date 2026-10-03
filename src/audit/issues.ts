import type { PageAnalysis } from "./analyze.ts";

export type Severity = "critical" | "warning" | "info";
export type Issue = { type: string; severity: Severity; detail?: string };

export const ISSUE_CATALOG: Record<string, { severity: Severity; title: string }> = {
  page_server_error: { severity: "critical", title: "Server answers with a 5xx error" },
  page_not_found: { severity: "critical", title: "Page answers with a 4xx error" },
  redirect_loop: { severity: "critical", title: "Redirects loop or never settle" },
  title_missing: { severity: "critical", title: "No <title> element" },
  title_too_long: { severity: "warning", title: "Title runs past 60 characters" },
  title_too_short: { severity: "info", title: "Title under 10 characters" },
  title_duplicate: { severity: "warning", title: "Same title on several pages" },
  meta_description_missing: { severity: "warning", title: "No meta description" },
  meta_description_too_long: { severity: "info", title: "Meta description runs past 160 characters" },
  meta_description_duplicate: { severity: "warning", title: "Same meta description on several pages" },
  h1_missing: { severity: "warning", title: "No <h1> heading" },
  h1_multiple: { severity: "info", title: "Several <h1> headings" },
  canonical_missing: { severity: "info", title: "No canonical link" },
  canonical_points_elsewhere: { severity: "info", title: "Canonical names another URL" },
  noindex: { severity: "warning", title: "Page asks search engines not to index it" },
  images_missing_alt: { severity: "warning", title: "Images lack alt text" },
  low_word_count: { severity: "info", title: "Little text (fewer than 200 words)" },
  slow_response: { severity: "warning", title: "Response took longer than 2 s" },
  missing_lang: { severity: "info", title: "No lang attribute on <html>" },
  missing_viewport: { severity: "warning", title: "No viewport meta tag" },
  mixed_content: { severity: "warning", title: "Secure page pulls in insecure resources" },
  not_https: { severity: "warning", title: "Page is reached over plain HTTP" },
  redirect_chain: { severity: "warning", title: "Two or more redirects before the page" },
  broken_internal_link: { severity: "warning", title: "Links to an internal page that is broken" },
  robots_txt_missing: { severity: "info", title: "robots.txt not found" },
  sitemap_missing: { severity: "info", title: "XML sitemap not found" },
  blocked_by_robots: { severity: "info", title: "Excluded by robots.txt" },
};

const mk = (type: string, detail?: string): Issue => ({ type, severity: ISSUE_CATALOG[type]!.severity, detail });

export type PageFacts = {
  url: string;
  finalUrl: string;
  status: number | null;
  responseMs: number | null;
  redirects: number;
  html: PageAnalysis | null;
};

/** Checks that look at one page on its own. */
export function pageIssues(p: PageFacts): Issue[] {
  const out: Issue[] = [];
  if (p.redirects >= 2) out.push(mk("redirect_chain", `${p.redirects} redirects in a row`));
  if (p.url.startsWith("http://")) out.push(mk("not_https"));
  if (p.status !== null && p.status >= 500) out.push(mk("page_server_error", `HTTP ${p.status}`));
  else if (p.status !== null && p.status >= 400 && p.status !== 401 && p.status !== 403 && p.status !== 429)
    out.push(mk("page_not_found", `HTTP ${p.status}`));
  if (p.responseMs !== null && p.responseMs > 2000) out.push(mk("slow_response", `${p.responseMs} ms`));
  const h = p.html;
  if (!h) return out;
  if (!h.title) out.push(mk("title_missing"));
  else if (h.title.length > 60) out.push(mk("title_too_long", `${h.title.length} chars`));
  else if (h.title.length < 10) out.push(mk("title_too_short", `${h.title.length} chars`));
  if (!h.metaDescription) out.push(mk("meta_description_missing"));
  else if (h.metaDescription.length > 160) out.push(mk("meta_description_too_long", `${h.metaDescription.length} chars`));
  if (h.h1Count === 0) out.push(mk("h1_missing"));
  else if (h.h1Count > 1) out.push(mk("h1_multiple", `${h.h1Count} <h1> tags`));
  if (!h.canonical) out.push(mk("canonical_missing"));
  else {
    try {
      const c = new URL(h.canonical, p.finalUrl);
      const f = new URL(p.finalUrl);
      if (c.origin + c.pathname.replace(/\/$/, "") !== f.origin + f.pathname.replace(/\/$/, ""))
        out.push(mk("canonical_points_elsewhere", c.href));
    } catch { /* an unparseable canonical is skipped */ }
  }
  if (h.noindex) out.push(mk("noindex"));
  if (h.imagesMissingAlt > 0) out.push(mk("images_missing_alt", `${h.imagesMissingAlt} of ${h.imagesTotal} images have none`));
  if (h.wordCount < 200) out.push(mk("low_word_count", `${h.wordCount} words`));
  if (!h.lang) out.push(mk("missing_lang"));
  if (!h.viewport) out.push(mk("missing_viewport"));
  if (p.finalUrl.startsWith("https://") && h.insecureResources.length > 0)
    out.push(mk("mixed_content", `${h.insecureResources.length} http:// resources`));
  return out;
}

/** Checks that compare pages with each other (duplicates, broken links); run once the crawl is done. */
export function siteIssues(pages: { url: string; status: number | null; title: string | null; metaDescription: string | null; internalLinks: string[] }[]): { url: string; issue: Issue }[] {
  const out: { url: string; issue: Issue }[] = [];
  const dupe = (key: "title" | "metaDescription", type: string) => {
    const groups = new Map<string, string[]>();
    for (const p of pages) {
      const v = p[key]?.trim().toLowerCase();
      if (v) groups.set(v, [...(groups.get(v) ?? []), p.url]);
    }
    for (const urls of groups.values())
      if (urls.length > 1) for (const url of urls) out.push({ url, issue: mk(type, `Used on ${urls.length} pages`) });
  };
  dupe("title", "title_duplicate");
  dupe("metaDescription", "meta_description_duplicate");
  const broken = new Set(pages.filter((p) => p.status !== null && p.status >= 400 && ![401, 403, 429].includes(p.status)).map((p) => p.url));
  for (const p of pages) {
    const hit = p.internalLinks.filter((l) => broken.has(l));
    if (hit.length) out.push({ url: p.url, issue: mk("broken_internal_link", hit.slice(0, 5).join(", ")) });
  }
  return out;
}

export { mk as makeIssue };
