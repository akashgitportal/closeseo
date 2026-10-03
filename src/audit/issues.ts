import type { PageAnalysis } from "./analyze.ts";

export type Severity = "critical" | "warning" | "info";
export type Issue = { type: string; severity: Severity; detail?: string };

export const ISSUE_CATALOG: Record<string, { severity: Severity; title: string }> = {
  page_server_error: { severity: "critical", title: "Page returns a 5xx server error" },
  page_not_found: { severity: "critical", title: "Page returns a 4xx client error" },
  redirect_loop: { severity: "critical", title: "Redirect loop or too many redirects" },
  title_missing: { severity: "critical", title: "Missing <title>" },
  title_too_long: { severity: "warning", title: "Title longer than 60 characters" },
  title_too_short: { severity: "info", title: "Title shorter than 10 characters" },
  title_duplicate: { severity: "warning", title: "Title shared by several pages" },
  meta_description_missing: { severity: "warning", title: "Missing meta description" },
  meta_description_too_long: { severity: "info", title: "Meta description longer than 160 characters" },
  meta_description_duplicate: { severity: "warning", title: "Meta description shared by several pages" },
  h1_missing: { severity: "warning", title: "Missing <h1>" },
  h1_multiple: { severity: "info", title: "More than one <h1>" },
  canonical_missing: { severity: "info", title: "Missing canonical link" },
  canonical_points_elsewhere: { severity: "info", title: "Canonical points to a different URL" },
  noindex: { severity: "warning", title: "Page is set to noindex" },
  images_missing_alt: { severity: "warning", title: "Images without alt text" },
  low_word_count: { severity: "info", title: "Thin content (under 200 words)" },
  slow_response: { severity: "warning", title: "Slow response (over 2 s)" },
  missing_lang: { severity: "info", title: "Missing html lang attribute" },
  missing_viewport: { severity: "warning", title: "Missing viewport meta tag" },
  mixed_content: { severity: "warning", title: "HTTPS page loads HTTP resources" },
  not_https: { severity: "warning", title: "Page is served over HTTP" },
  redirect_chain: { severity: "warning", title: "Redirect chain of 2+ hops" },
  broken_internal_link: { severity: "warning", title: "Links to a broken internal page" },
  robots_txt_missing: { severity: "info", title: "No robots.txt found" },
  sitemap_missing: { severity: "info", title: "No XML sitemap found" },
  blocked_by_robots: { severity: "info", title: "Disallowed by robots.txt" },
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

/** Per-page checks that need no site-wide context. */
export function pageIssues(p: PageFacts): Issue[] {
  const out: Issue[] = [];
  if (p.redirects >= 2) out.push(mk("redirect_chain", `${p.redirects} redirects`));
  if (p.url.startsWith("http://")) out.push(mk("not_https"));
  if (p.status !== null && p.status >= 500) out.push(mk("page_server_error", `HTTP ${p.status}`));
  else if (p.status !== null && p.status >= 400 && p.status !== 401 && p.status !== 403 && p.status !== 429)
    out.push(mk("page_not_found", `HTTP ${p.status}`));
  if (p.responseMs !== null && p.responseMs > 2000) out.push(mk("slow_response", `${p.responseMs} ms`));
  const h = p.html;
  if (!h) return out;
  if (!h.title) out.push(mk("title_missing"));
  else if (h.title.length > 60) out.push(mk("title_too_long", `${h.title.length} characters`));
  else if (h.title.length < 10) out.push(mk("title_too_short", `${h.title.length} characters`));
  if (!h.metaDescription) out.push(mk("meta_description_missing"));
  else if (h.metaDescription.length > 160) out.push(mk("meta_description_too_long", `${h.metaDescription.length} characters`));
  if (h.h1Count === 0) out.push(mk("h1_missing"));
  else if (h.h1Count > 1) out.push(mk("h1_multiple", `${h.h1Count} h1 elements`));
  if (!h.canonical) out.push(mk("canonical_missing"));
  else {
    try {
      const c = new URL(h.canonical, p.finalUrl);
      const f = new URL(p.finalUrl);
      if (c.origin + c.pathname.replace(/\/$/, "") !== f.origin + f.pathname.replace(/\/$/, ""))
        out.push(mk("canonical_points_elsewhere", c.href));
    } catch { /* malformed canonical: ignore */ }
  }
  if (h.noindex) out.push(mk("noindex"));
  if (h.imagesMissingAlt > 0) out.push(mk("images_missing_alt", `${h.imagesMissingAlt} of ${h.imagesTotal} images`));
  if (h.wordCount < 200) out.push(mk("low_word_count", `${h.wordCount} words`));
  if (!h.lang) out.push(mk("missing_lang"));
  if (!h.viewport) out.push(mk("missing_viewport"));
  if (p.finalUrl.startsWith("https://") && h.insecureResources.length > 0)
    out.push(mk("mixed_content", `${h.insecureResources.length} insecure resources`));
  return out;
}

/** Site-wide checks (duplicates, broken links) computed after the crawl. */
export function siteIssues(pages: { url: string; status: number | null; title: string | null; metaDescription: string | null; internalLinks: string[] }[]): { url: string; issue: Issue }[] {
  const out: { url: string; issue: Issue }[] = [];
  const dupe = (key: "title" | "metaDescription", type: string) => {
    const groups = new Map<string, string[]>();
    for (const p of pages) {
      const v = p[key]?.trim().toLowerCase();
      if (v) groups.set(v, [...(groups.get(v) ?? []), p.url]);
    }
    for (const urls of groups.values())
      if (urls.length > 1) for (const url of urls) out.push({ url, issue: mk(type, `Shared by ${urls.length} pages`) });
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
