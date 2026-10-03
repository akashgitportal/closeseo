import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { hostMatchesDomain, normalizeDomain } from "../src/domain-utils.ts";
import { parseResearchTarget } from "../src/services/researchScope.ts";
import { parseRobots } from "../src/audit/robots.ts";
import { analyzeHtml } from "../src/audit/analyze.ts";
import { pageIssues, siteIssues } from "../src/audit/issues.ts";
import { isBlockedAddress, assertCrawlableUrl } from "../src/audit/url-policy.ts";
import { normalizeUrl, parseSitemap } from "../src/audit/crawl.ts";
import { computeNextCheckAt } from "../src/services/schedule.ts";
import { interleaveRows, isAdsKeyword, normalizeIntent } from "../src/services/keywords.ts";
import { assertLanguageForLocation, getKeywordDataProvider, getLanguageCode, isoCountryCode, resolveLabsMarket, resolveMarket } from "../src/services/markets.ts";
import { costPerSerpAtDepth, estimateRankCheck, estimateScheduled, keywordCostMultiplier } from "../src/services/rankPricing.ts";

test("normalizeDomain strips scheme, path, port, www and lowercases", () => {
  assert.equal(normalizeDomain("HTTPS://www.Example.COM:8080/a/b?q=1#x"), "example.com");
  assert.equal(normalizeDomain("blog.example.co.uk"), "blog.example.co.uk");
});
test("normalizeDomain rejects junk", () => {
  for (const bad of ["", "   ", "nodot", "exa mple.com", "-a.com", "http://", "a..com"]) assert.throws(() => normalizeDomain(bad), /valid domain|empty/, bad);
});
test("hostMatchesDomain only matches the domain or its subdomains", () => {
  assert.ok(hostMatchesDomain("example.com", "example.com"));
  assert.ok(hostMatchesDomain("blog.example.com", "example.com"));
  assert.ok(!hostMatchesDomain("notexample.com", "example.com"));
  assert.ok(!hostMatchesDomain("example.com.evil.io", "example.com"));
});
test("research target: scope defaults, display, path normalisation, validation messages", () => {
  const t = (i: string, sc?: any) => parseResearchTarget(i, sc);
  assert.deepEqual(t("Example.COM"), { scope: "subdomains", hostname: "example.com", urlHostname: "example.com", path: "", display: "example.com" });
  assert.deepEqual(t("https://www.Example.com/Blog/?q=1#frag"), { scope: "subfolder", hostname: "example.com", urlHostname: "www.example.com", path: "/Blog", display: "example.com/Blog" });
  assert.equal(t("https://example.com/").scope, "subdomains");
  assert.equal(t("example.com/a/b", "exact_url").display, "example.com/a/b");
  assert.equal(t("example.com/a/b", "domain").display, "example.com");
  assert.equal(t("shop.example.co.uk").hostname, "shop.example.co.uk");
  assert.throws(() => t("   "), /Enter a domain or URL/);
  assert.throws(() => t("example.com", "subfolder"), /Add a path to use Subfolder/);
  for (const bad of ["not a domain", "example.por", "my_site.com", "localhost", "192.168.0.1", "http://", "user:pw@example.com"]) assert.throws(() => t(bad), /valid domain|credentials/, bad);
});
test("config: defaults and validation", () => {
  const c = loadConfig({} as never);
  assert.equal(c.authMode, "local_noauth"); assert.equal(c.port, 3001); assert.equal(c.host, "127.0.0.1");
  assert.throws(() => loadConfig({ AUTH_MODE: "hosted" } as never), /AUTH_MODE/);
  assert.throws(() => loadConfig({ AUTH_MODE: "api_key" } as never), /CLOSESEO_API_KEY/);
  assert.throws(() => loadConfig({ PORT: "abc" } as never), /PORT/);
  assert.throws(() => loadConfig({ PORT: "70000" } as never), /PORT/);
  assert.equal(loadConfig({ PUBLIC_URL: "https://x.io///" } as never).publicUrl, "https://x.io");
});

test("robots.txt: longest match wins, allow beats disallow on ties, wildcards, crawl-delay, sitemaps", () => {
  const r = parseRobots(`User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\nCrawl-delay: 2\nSitemap: https://e.com/s.xml\n\nUser-agent: badbot\nDisallow: /`);
  assert.ok(!r.isAllowed("/private/x")); assert.ok(r.isAllowed("/private/ok/page"));
  assert.ok(!r.isAllowed("/a/file.pdf")); assert.ok(r.isAllowed("/a/file.pdf.html"));
  assert.ok(r.isAllowed("/public"));
  assert.equal(r.crawlDelayMs, 2000); assert.deepEqual(r.sitemaps, ["https://e.com/s.xml"]);
});
test("robots.txt: our own user-agent group overrides *", () => {
  const r = parseRobots(`User-agent: *\nDisallow: /\n\nUser-agent: CloseSEOBot\nAllow: /`);
  assert.ok(r.isAllowed("/anything"));
  assert.ok(!parseRobots("User-agent: *\nDisallow: /").isAllowed("/x"));
  assert.ok(parseRobots("User-agent: *\nDisallow:").isAllowed("/x"), "empty Disallow allows everything");
});

test("analyzeHtml extracts SEO facts", () => {
  const a = analyzeHtml(`<html lang="en"><head><title> Hello  World </title><meta name="description" content="Desc"><meta name="viewport" content="x">
    <meta name="robots" content="noindex, follow"><link rel="canonical" href="/c"><script type="application/ld+json">{}</script></head>
    <body><h1>A</h1><h1>B</h1><p>one two three</p><script>var ignored = "words words";</script><img src="a.png"><img src="b.png" alt="ok"><a href="/x">x</a><a href="/y" rel="nofollow">y</a><img src="http://insecure/i.png" alt="z"></body></html>`);
  assert.equal(a.title, "Hello World"); assert.equal(a.metaDescription, "Desc"); assert.equal(a.lang, "en");
  assert.ok(a.viewport && a.noindex && !a.nofollow && a.hasStructuredData);
  assert.equal(a.h1Count, 2); assert.equal(a.canonical, "/c");
  assert.equal(a.imagesTotal, 3); assert.equal(a.imagesMissingAlt, 1);
  assert.equal(a.links.length, 2); assert.equal(a.insecureResources.length, 1);
  assert.equal(a.wordCount, 7, "script text excluded: A B one two three x y");
});
test("analyzeHtml survives garbage", () => {
  assert.doesNotThrow(() => analyzeHtml("<<<>>><div<p>unclosed <b>"));
  assert.equal(analyzeHtml("").title, null);
});
test("pageIssues flags what it should and nothing for a healthy page", () => {
  const healthy = analyzeHtml(`<html lang="en"><head><title>A reasonably good page title</title><meta name="description" content="d"><meta name="viewport" content="w"><link rel="canonical" href="https://e.com/p"></head><body><h1>x</h1>${"word ".repeat(250)}</body></html>`);
  assert.deepEqual(pageIssues({ url: "https://e.com/p", finalUrl: "https://e.com/p", status: 200, responseMs: 100, redirects: 0, html: healthy }), []);
  const bad = pageIssues({ url: "http://e.com/p", finalUrl: "http://e.com/p", status: 200, responseMs: 5000, redirects: 3, html: analyzeHtml("<html><body><p>hi</p></body></html>") }).map((i) => i.type);
  for (const t of ["not_https", "slow_response", "redirect_chain", "title_missing", "meta_description_missing", "h1_missing", "canonical_missing", "low_word_count", "missing_lang", "missing_viewport"]) assert.ok(bad.includes(t), t);
  assert.equal(pageIssues({ url: "https://e.com/x", finalUrl: "https://e.com/x", status: 404, responseMs: 1, redirects: 0, html: null })[0]!.severity, "critical");
  assert.equal(pageIssues({ url: "https://e.com/x", finalUrl: "https://e.com/x", status: 403, responseMs: 1, redirects: 0, html: null }).length, 0, "403 is 'blocked', not 'broken'");
});
test("siteIssues finds duplicates and broken internal links", () => {
  const out = siteIssues([
    { url: "https://e.com/a", status: 200, title: "Same", metaDescription: null, internalLinks: ["https://e.com/gone"] },
    { url: "https://e.com/b", status: 200, title: "same", metaDescription: null, internalLinks: [] },
    { url: "https://e.com/gone", status: 404, title: null, metaDescription: null, internalLinks: [] },
  ]).map((x) => `${x.issue.type}@${x.url}`).sort();
  assert.deepEqual(out, ["broken_internal_link@https://e.com/a", "title_duplicate@https://e.com/a", "title_duplicate@https://e.com/b"]);
});

test("SSRF policy blocks private, loopback, link-local, mapped and metadata addresses", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "224.0.0.1"]) assert.ok(isBlockedAddress(a), a);
  for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) assert.ok(!isBlockedAddress(a), a);
  for (const u of ["http://localhost/", "http://127.0.0.1:8080/", "http://[::1]/", "http://169.254.169.254/latest", "http://foo.internal/", "ftp://example.com/", "file:///etc/passwd", "http://user:pw@example.com/", "javascript:alert(1)", "not a url"])
    assert.throws(() => assertCrawlableUrl(u), /private|local|http|credentials|valid/i, u);
  assert.doesNotThrow(() => assertCrawlableUrl("https://example.com/"));
  assert.doesNotThrow(() => assertCrawlableUrl("http://127.0.0.1/", true));
});
test("URL normalization and sitemap parsing", () => {
  assert.equal(normalizeUrl("HTTPS://Example.com:443/a/#frag"), "https://example.com/a");
  assert.equal(normalizeUrl("/x/", "https://e.com/y"), "https://e.com/x");
  assert.equal(normalizeUrl("mailto:a@b.c"), null);
  assert.deepEqual(parseSitemap(`<urlset><url><loc> https://e.com/a </loc></url><url><loc>https://e.com/b</loc></url></urlset>`).urls, ["https://e.com/a", "https://e.com/b"]);
  assert.deepEqual(parseSitemap(`<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>`).sitemaps, ["https://e.com/s1.xml"]);
});

test("schedule: first check uses the chosen time (in its zone) or a random 04-09 UTC slot; later checks advance from the anchor", () => {
  const now = Date.parse("2026-03-07T12:00:00Z"); // a Saturday
  const fixed = () => 0; // rand -> hour 4, minute 0
  assert.equal(computeNextCheckAt("daily", null, undefined, now, fixed), "2026-03-08T04:00:00.000Z");
  assert.equal(computeNextCheckAt("weekly", null, undefined, now, fixed), "2026-03-14T04:00:00.000Z");
  const top = () => 0.9999; // hour 9, minute 59
  assert.equal(computeNextCheckAt("daily", null, undefined, now, top), "2026-03-08T09:59:00.000Z");
  assert.equal(computeNextCheckAt("daily", null, { hour: 6, minute: 30 }, now), "2026-03-08T06:30:00.000Z", "a time already passed today runs tomorrow");
  assert.equal(computeNextCheckAt("daily", null, { hour: 18, minute: 0 }, now), "2026-03-07T18:00:00.000Z", "a time later today runs today");
  assert.equal(computeNextCheckAt("weekly", null, { weekday: 3, hour: 0, minute: 0 }, now), "2026-03-11T00:00:00.000Z");
  // 09:00 New York on 2026-03-07 is UTC-5 (EST) -> 14:00 UTC
  assert.equal(computeNextCheckAt("daily", null, { hour: 9, minute: 0, timeZone: "America/New_York" }, now), "2026-03-07T14:00:00.000Z", "09:00 New York (UTC-5 right now) is 14:00Z, still later today");
  assert.equal(computeNextCheckAt("daily", "2026-03-01T05:00:00.000Z", undefined, now), "2026-03-08T05:00:00.000Z", "advances by whole days from the anchor, never drifting");
  assert.equal(computeNextCheckAt("weekly", "2026-03-02T05:00:00.000Z", undefined, now), "2026-03-09T05:00:00.000Z");
  assert.equal(computeNextCheckAt("monthly", null, { hour: 5, minute: 0 }, now), "2026-03-31T05:00:00.000Z", "monthly runs on the last day of the month");
  assert.equal(computeNextCheckAt("monthly", "2026-03-31T05:00:00.000Z", undefined, Date.parse("2026-04-01T00:00:00Z")), "2026-04-30T05:00:00.000Z");
  assert.equal(computeNextCheckAt("monthly", "2026-04-30T05:00:00.000Z", undefined, Date.parse("2026-05-01T00:00:00Z")), "2026-05-31T05:00:00.000Z");
  assert.equal(computeNextCheckAt("monthly", "2026-02-28T05:00:00.000Z", undefined, Date.parse("2026-03-01T00:00:00Z")), "2026-03-31T05:00:00.000Z");
});

test("interleaveRows alternates sources, dedupes and honours the limit", () => {
  const row = (keyword: string) => ({ keyword, searchVolume: 1, keywordDifficulty: 1, cpc: 1, competition: 1, intent: "unknown" as const, trend: [] });
  const out = interleaveRows([row("a"), row("b"), row("c")], [row("x"), row("a"), row("y")], 5).map((r) => r.keyword);
  assert.deepEqual(out, ["a", "x", "b", "c", "y"]);
  assert.deepEqual(interleaveRows([row("a")], [row("a")], 10).map((r) => r.keyword), ["a"]);
  assert.equal(interleaveRows([row("a"), row("b")], [row("c")], 2).length, 2);
});
test("normalizeIntent and Google Ads keyword eligibility", () => {
  assert.deepEqual(["Informational", "COMMERCIAL", "transactional", "navigational", "", null, "weird"].map((x) => normalizeIntent(x as string)), ["informational", "commercial", "transactional", "navigational", "unknown", "unknown", "unknown"]);
  assert.ok(isAdsKeyword("normal seo keyword")); assert.ok(!isAdsKeyword("bad, comma")); assert.ok(!isAdsKeyword("emoji 🚀")); assert.ok(!isAdsKeyword("x".repeat(81))); assert.ok(!isAdsKeyword("a b c d e f g h i j k"));
});
test("market registry: providers, languages, resolution rules", () => {
  assert.equal(getKeywordDataProvider(2840), "labs"); assert.equal(getKeywordDataProvider(2352), "google_ads"); assert.equal(getKeywordDataProvider(999999), "labs", "unknown codes fall back to Labs");
  assert.equal(getLanguageCode(2276), "de"); assert.equal(getLanguageCode(999999), "en");
  assert.equal(isoCountryCode(2826), "gb", "UK is exposed as GB"); assert.equal(isoCountryCode(2840), "us");
  const project = { locationCode: 2704, languageCode: "vi" };
  assert.deepEqual(resolveMarket({ locationCode: 2276 }, project), { locationCode: 2276, languageCode: "de" }, "a new location snaps to its own language");
  assert.deepEqual(resolveMarket({ languageCode: "en" }, project), { locationCode: 2704, languageCode: "en" });
  assert.deepEqual(resolveMarket({}, project), project);
  assert.deepEqual(resolveLabsMarket({}, { locationCode: 2352, languageCode: "is" }), { locationCode: 2840, languageCode: "en" }, "a project market Labs cannot serve falls back to the US");
  assert.throws(() => assertLanguageForLocation(2840, "ru"), /Language 'ru' is not available for this location\. Available: en, es\./);
  assert.doesNotThrow(() => assertLanguageForLocation(2840, "es")); assert.doesNotThrow(() => assertLanguageForLocation(2352, "is"));
});
test("rank tracking pricing: live vs queued pages, operator multiplier, per-call ceilings, markup", () => {
  assert.equal(costPerSerpAtDepth(10, "live"), 0.002); assert.ok(Math.abs(costPerSerpAtDepth(20, "live") - 0.0035) < 1e-12);
  assert.equal(costPerSerpAtDepth(10, "queued"), 0.0006); assert.ok(Math.abs(costPerSerpAtDepth(40, "queued") - 0.00195) < 1e-12);
  assert.equal(keywordCostMultiplier("site:example.com seo"), 5); assert.equal(keywordCostMultiplier("plain keyword"), 1);
  // live: each keyword/device check is its own call, ceiled separately: ceil(3.5) x 4 = 16
  assert.deepEqual(estimateRankCheck(["a", "b"], "both", 20, "live"), { costUsd: 0.014, costCredits: 16 });
  // queued: one post covers up to 100 checks: 4 x 0.00105 = 0.0042 -> ceil(4.2) = 5
  assert.deepEqual(estimateRankCheck(["a", "b"], "both", 20, "queued"), { costUsd: 0.0042, costCredits: 5 });
  assert.deepEqual(estimateRankCheck(["a", "b"], "both", 20, "live", 1.28), { costUsd: 0.01792, costCredits: 20 }, "1.28 markup reproduces the SOURCE's hosted figures");
  assert.equal(estimateRankCheck([], "both", 20, "live").costCredits, 0);
  assert.equal(estimateRankCheck(Array(150).fill("k"), "desktop", 10, "queued").costCredits, 60 + 30, "150 checks = two posts (100 + 50), ceiled separately");
  assert.deepEqual(estimateScheduled(["a", "b"], "both", 20, "weekly", 1.28), { scheduleInterval: "weekly", costUsd: 0.00538, costCredits: 6, checksPerMonth: 4, monthlyCostUsd: 0.00538 * 4, monthlyCostCredits: 24 });
});

test("validation messages: unknown keys and union failures read like the SOURCE", async () => {
  const { formatValidationError } = await import("../src/mcp/validation.ts");
  assert.equal(formatValidationError("t", [{ keyword: "additionalProperties", instancePath: "", schemaPath: "#/additionalProperties", params: { additionalProperty: "bogus" }, message: "x" }]), 'Input validation error: Invalid arguments for tool t: Unrecognized key: "bogus"');
  assert.equal(formatValidationError("t", [{ keyword: "additionalProperties", instancePath: "/filters/0", schemaPath: "#/additionalProperties", params: { additionalProperty: "z" }, message: "x" }]), 'Input validation error: Invalid arguments for tool t: filters.0: Unrecognized key: "z"');
});
