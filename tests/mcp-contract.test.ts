import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startFakeDfs, type FakeDfs } from "./support/fake-dataforseo.ts";
import { makeClient, makeCtx } from "./support/harness.ts";
import { UNSUPPORTED_TOOLS } from "../src/mcp/tools.ts";

const require = createRequire(import.meta.url);
const golden = require("./golden/mcp-tools-list.json") as { tools: { name: string }[] };

let dfs: FakeDfs;
let c: ReturnType<typeof makeClient>;
let pid: string;
before(async () => {
  dfs = await startFakeDfs();
  c = makeClient(makeCtx({ dfsUrl: dfs.url, ENABLE_PUBLIC_SHARING: "1" }));
  const r = await c.tool("create_project", { name: "Contract", domain: "example.com" });
  pid = r.structuredContent.project.id;
});
after(() => dfs.close());

test("initialize negotiates protocol version and advertises tools", async () => {
  const r = await c.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(r.result.protocolVersion, "2025-03-26");
  assert.deepEqual(r.result.capabilities.tools, { listChanged: false });
  assert.equal((await c.rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, "2025-06-18");
});
test("tools/list is identical to the SOURCE contract (names, order, schemas)", async () => {
  const r = await c.rpc("tools/list");
  assert.deepEqual(r.result.tools, golden.tools);
  assert.equal(r.result.tools.length, 58);
});
test("every listed tool has a handler: all 58 are implemented", async () => {
  for (const t of golden.tools) {
    const resp = await c.rpc("tools/call", { name: t.name, arguments: {} });
    assert.ok(resp.result, `${t.name} must answer, not 'unknown tool'`);
  }
  assert.equal(UNSUPPORTED_TOOLS.length, 0, "nothing is left unimplemented");
  const r = await c.tool("get_business_profile", { projectId: pid });
  assert.ok(r.isError); assert.match(r.content[0]!.text, /exactly one of businessName, cid or placeId/);
});
test("protocol edge cases: notifications, batch, unknown method/tool, bad JSON, non-POST", async () => {
  assert.equal((await c.post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const batch = await (await c.post("/mcp", [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 3, method: "tools/list" }])).json() as any[];
  assert.equal(batch.length, 2);
  assert.equal((await c.rpc("nope")).error!.code, -32601);
  assert.equal((await c.rpc("tools/call", { name: "does_not_exist" })).error!.code, -32602);
  assert.equal((await c.rpc("tools/call", {})).error!.code, -32602);
  const bad = await c.app.request("/mcp", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
  assert.equal(bad.status, 400); assert.equal(((await bad.json()) as any).error.code, -32700);
  assert.equal((await c.post("/mcp", { jsonrpc: "1.0", id: 1, method: "ping" })).status, 200);
  assert.equal((await c.post("/mcp", [])).status, 400);
  assert.equal((await c.get("/mcp")).status, 405);
});
test("argument validation uses the SOURCE input schemas", async () => {
  const missing = await c.tool("save_keywords", { projectId: pid });
  assert.ok(missing.isError); assert.match(missing.content[0]!.text, /keywords/);
  assert.ok((await c.tool("create_project", { name: "" })).isError, "minLength");
  assert.ok((await c.tool("create_project", { name: "x".repeat(121) })).isError, "maxLength");
  assert.ok((await c.tool("list_saved_keywords", { projectId: pid, limit: 7 })).isError, "enum of limits");
  assert.ok((await c.tool("get_rank_tracker", { projectId: pid, trackerId: "not-a-uuid" })).isError, "uuid format");
  assert.ok((await c.tool("save_keywords", { projectId: pid, keywords: Array(101).fill("a") })).isError, "maxItems");
  assert.ok((await c.tool("update_project_context", { projectId: pid, updates: [{ customSection: "Bad_Slug", content: "x" }] })).isError, "slug pattern");
});

test("project lifecycle and error shape", async () => {
  const created = await c.tool("create_project", { name: "  Spaces  ", domain: "HTTPS://WWW.Shop.Example.com/x", locationCode: 2276 });
  const p = created.structuredContent.project;
  assert.equal(p.name, "Spaces"); assert.equal(p.domain, "shop.example.com"); assert.equal(p.languageCode, "de");
  assert.match(p.url, /\/p\/[0-9a-f-]{36}$/); assert.equal(created._meta.url, p.url);
  const lp = await c.tool("create_project", { name: "NoLoc", languageCode: "fr" });
  assert.ok(lp.isError, "languageCode without locationCode");
  assert.ok((await c.tool("create_project", { name: "Org", organizationId: "x" })).isError, "single-tenant");
  assert.ok((await c.tool("create_project", { name: "Bad", domain: "not a domain" })).isError);
  const list = await c.tool("list_projects");
  assert.ok(list.structuredContent.projects.length >= 2);
  const nf = await c.tool("get_project_context", { projectId: "00000000-0000-0000-0000-000000000000" });
  assert.deepEqual([nf.isError, nf.content[0]!.text], [true, "No project with that id exists"]);
});

test("whoami matches self-hosted semantics", async () => {
  const r = await c.tool("whoami");
  assert.deepEqual(r.structuredContent, { userEmail: "admin@localhost", scopes: [], mode: "self-hosted", creditsRemaining: null });
});

test("project context: patch operations, limits, normalization", async () => {
  const empty = await c.tool("get_project_context", { projectId: pid });
  assert.deepEqual(empty.structuredContent.missingSections.sort(), ["business_overview", "current_goal", "positioning", "writing_preferences"]);
  const r = await c.tool("update_project_context", { projectId: pid, updates: [
    { section: "business_overview", content: "We sell widgets" },
    { customSection: "launch-plan", title: "Launch plan", content: "Q4" },
    { addCompetitors: [{ domain: "https://www.Rival.com/x", name: "Rival", notes: "main" }] },
    { addKeyPages: [{ url: "https://example.com/pricing", role: "money", topic: "pricing" }] },
    { appendResearchLog: { summary: "Researched widgets" } },
  ] });
  const s = r.structuredContent;
  assert.equal(s.sections[0].content, "We sell widgets"); assert.ok(!s.missingSections.includes("business_overview"));
  assert.equal(s.customSections[0].slug, "launch-plan"); assert.equal(s.customSections[0].title, "Launch plan");
  assert.equal(s.competitors[0].domain, "rival.com"); assert.equal(s.competitors[0].name, "Rival");
  assert.equal(s.keyPages[0].role, "money"); assert.equal(s.researchLog.length, 1);
  const logId = s.researchLog[0].id;
  const r2 = await c.tool("update_project_context", { projectId: pid, updates: [
    { section: "business_overview", content: "" }, { deleteCustomSection: "launch-plan" },
    { removeCompetitors: ["rival.com"] }, { removeKeyPages: ["https://example.com/pricing"] }, { removeResearchLog: [logId] },
  ] });
  assert.deepEqual([r2.structuredContent.sections.length, r2.structuredContent.customSections.length, r2.structuredContent.competitors.length, r2.structuredContent.keyPages.length, r2.structuredContent.researchLog.length], [0, 0, 0, 0, 0]);
  const tooLong = await c.tool("update_project_context", { projectId: pid, updates: [{ section: "positioning", content: "x".repeat(4001) }] });
  assert.ok(tooLong.isError);
  // a failing op rolls the whole batch back
  const atomic = await c.tool("update_project_context", { projectId: pid, updates: [{ section: "current_goal", content: "goal" }, { addCompetitors: [{ domain: "bad domain" }] }] });
  assert.ok(atomic.isError);
  assert.deepEqual((await c.tool("get_project_context", { projectId: pid })).structuredContent.sections, [], "atomic rollback");
});

test("saved keywords: dedupe, tags (append/replace), search, limits, removal", async () => {
  const s1 = await c.tool("save_keywords", { projectId: pid, keywords: ["Widget  Tools", "widget tools", "gadgets"], tags: ["Alpha", "beta"], metrics: [{ keyword: "gadgets", searchVolume: 900, keywordDifficulty: 33, cpc: 1.5, competition: 0.4, intent: "commercial" }] });
  // Keys are trimmed + lower-cased only (inner whitespace is significant, as in the SOURCE): "Widget  Tools" != "widget tools".
  assert.deepEqual([s1.structuredContent.savedCount, s1.structuredContent.keywords], [3, ["Widget  Tools", "widget tools", "gadgets"]]);
  const dup = await c.tool("save_keywords", { projectId: pid, keywords: ["GADGETS ", "gadgets"] });
  assert.deepEqual([dup.structuredContent.savedCount, dup.structuredContent.keywords], [1, ["GADGETS"]]);
  await c.tool("save_keywords", { projectId: pid, keywords: ["gadgets"], tags: ["gamma"] });
  let l = (await c.tool("list_saved_keywords", { projectId: pid })).structuredContent;
  assert.equal(l.totalCount, 3);
  const g = l.rows.find((r: any) => r.keyword === "gadgets");
  assert.deepEqual([g.searchVolume, g.keywordDifficulty, g.intent, g.tags], [900, 33, "commercial", ["Alpha", "beta", "gamma"]]);
  await c.tool("save_keywords", { projectId: pid, keywords: ["gadgets"], tags: ["only"], tagMode: "replace" });
  l = (await c.tool("list_saved_keywords", { projectId: pid, tags: ["ONLY"] })).structuredContent;
  assert.deepEqual(l.rows.map((r: any) => r.keyword), ["gadgets"]);
  assert.ok(l.tags.some((t: any) => t.name === "only" && t.keywordCount === 1));
  assert.equal((await c.tool("list_saved_keywords", { projectId: pid, search: "WIDGET" })).structuredContent.rows.length, 2);
  assert.equal((await c.tool("list_saved_keywords", { projectId: pid, search: "100%_" })).structuredContent.rows.length, 0, "LIKE wildcards are escaped");
  assert.equal((await c.tool("list_saved_keywords", { projectId: pid, limit: 50 })).structuredContent.rows.length, 3);
  const ids = l.rows.map((r: any) => r.id);
  const rm = await c.tool("remove_saved_keywords", { projectId: pid, savedKeywordIds: [...ids, "missing-id"] });
  assert.deepEqual([rm.structuredContent.requested, rm.structuredContent.deletedCount], [2, 1]);
});

test("DataForSEO-backed read tools return schema-valid output", async () => {
  const kw = (await c.tool("research_keywords", { projectId: pid, seeds: [{ seed: "seo tools" }, { seed: "nodata thing" }, { seed: "seo tools", locationCode: 2352, languageCode: "is" }] })).structuredContent.results;
  assert.deepEqual([kw[0].ok, kw[0].source, kw[0].usedFallback], [true, "blended", false]);
  assert.ok(kw[0].rows.length > 5 && kw[0].rows.length <= 150);
  assert.deepEqual(Object.keys(kw[0].rows[0]).sort(), ["competition", "cpc", "intent", "keyword", "keywordDifficulty", "searchVolume"]);
  assert.ok(kw[0].rows.every((r: any) => r.keyword === r.keyword.toLowerCase()), "keywords are lower-cased");
  assert.equal(new Set(kw[0].rows.map((r: any) => r.keyword)).size, kw[0].rows.length, "no duplicates");
  assert.deepEqual([kw[1].rowCount, kw[1].source, kw[1].usedFallback], [0, "blended", true], "thin result tops up from related keywords");
  assert.deepEqual([kw[2].source, kw[2].usedFallback, kw[2].rows[0].keywordDifficulty, kw[2].rows[0].intent], ["google_ads", false, null, "unknown"], "Ads-only market");
  const bodies = dfs.stats().bodies;
  assert.equal((bodies["/v3/dataforseo_labs/google/keyword_suggestions/live"]!.at(-1) as any).limit, 75, "blend asks each leg for half the limit");
  assert.equal((bodies["/v3/dataforseo_labs/google/keyword_ideas/live"]!.at(-1) as any).ignore_synonyms, true);
  const cs = (await c.tool("research_keywords", { projectId: pid, seeds: [{ seed: "cs seed" }], includeClickstreamData: true, groupKeywords: true, resultLimit: 300 })).structuredContent.results[0];
  assert.equal(cs.ok, true);
  const csBody = dfs.stats().bodies["/v3/dataforseo_labs/google/keyword_suggestions/live"]!.at(-1) as any;
  assert.deepEqual([csBody.include_clickstream_data, csBody.ignore_synonyms, csBody.limit], [true, false, 150]);
  const callsBefore = dfs.stats().total;
  await c.tool("research_keywords", { projectId: pid, seeds: [{ seed: "seo tools" }] });
  assert.equal(dfs.stats().total, callsBefore, "identical research is served from cache");
  assert.ok((await c.tool("research_keywords", { projectId: pid, seeds: [{ seed: "x", languageCode: "ru" }] })).structuredContent.results[0].ok === false, "unsupported language for the market is a per-seed failure");
  const local = (await c.tool("research_keywords", { projectId: pid, seeds: [{ seed: "seo tools", locationName: "New York,New York,United States" }, { seed: "seo tools", locationName: "Atlantis" }] })).structuredContent.results;
  assert.equal(local[0].ok, true); assert.equal(local[1].ok, false); assert.match(local[1].error, /No city, county or region called "Atlantis" exists in United States/);
  const m = (await c.tool("get_keyword_metrics", { projectId: pid, keywords: ["b kw", "a kw", "a kw"], sortBy: "search_volume" })).structuredContent.keywords;
  assert.equal(m.length, 3, "inputs are passed through as given, not deduplicated"); assert.deepEqual(Object.keys(m[0]), ["keyword", "search_volume", "keyword_difficulty", "main_intent", "cpc", "competition", "competition_level", "monthly_searches"]);
  assert.equal(m[0].monthly_searches.length, 12); assert.ok(m[0].search_volume >= m[1].search_volume);
  assert.ok(!("monthly_searches" in (await c.tool("get_keyword_metrics", { projectId: pid, keywords: ["a"], includeMonthlyTrends: false })).structuredContent.keywords[0]));
  assert.ok((await c.tool("get_keyword_metrics", { projectId: pid, keywords: ["a"], languageCode: "ru" })).isError, "language must be served for the location");
  const ads = (await c.tool("get_keyword_metrics", { projectId: pid, keywords: ["a", "bad,comma"], locationCode: 2352 })).structuredContent.keywords;
  assert.deepEqual([ads.length, ads[0].keyword_difficulty, ads[0].main_intent], [1, null, null], "Ads route skips keywords Ads would reject");
  const o = (await c.tool("get_domain_overview", { projectId: pid, domain: "https://www.example.com/blog/" })).structuredContent;
  assert.deepEqual([o.domain, o.scope, o.displayTarget, o.backlinks, o.referringDomains, o.hasData], ["example.com", "subfolder", "example.com/blog", null, null, true]);
  assert.equal(typeof o.organicTraffic, "number"); assert.ok(!Number.isNaN(Date.parse(o.fetchedAt)));
  assert.equal((await c.tool("get_domain_overview", { projectId: pid, domain: "example.com" })).structuredContent.scope, "subdomains");
  assert.equal((await c.tool("get_domain_overview", { projectId: pid, domain: "example.com", includeSubdomains: false })).structuredContent.scope, "domain");
  const ovCalls = dfs.stats().byPath["/v3/dataforseo_labs/google/domain_rank_overview/live"];
  await c.tool("get_domain_overview", { projectId: pid, domain: "example.com", scope: "domain" });
  assert.equal(dfs.stats().byPath["/v3/dataforseo_labs/google/domain_rank_overview/live"], ovCalls, "overview is cached per hostname across scopes");
  assert.ok((await c.tool("get_domain_overview", { projectId: pid, domain: "example.com", locationCode: 2352 })).isError, "Labs-only tool rejects Ads-only countries");
  const rk = (await c.tool("get_ranked_keywords", { projectId: pid, target: "example.com", limit: 10, offset: 5, sortBy: "rank", minSearchVolume: 10, maxRank: 50, excludeBrandTerms: ["acme"] })).structuredContent;
  assert.equal(rk.keywords.length, 10); assert.equal(rk.totalCount, 37); assert.equal(rk.target, "example.com"); assert.equal(rk.scope, "subdomains");
  assert.ok(rk.keywords[0].keyword_data && rk.keywords[0].ranked_serp_element, "provider rows are passed through unchanged");
  const body = dfs.stats().bodies["/v3/dataforseo_labs/google/ranked_keywords/live"]!.at(-1) as any;
  assert.deepEqual([body.offset, body.limit, body.item_types, body.order_by], [5, 10, ["organic", "paid"], ["ranked_serp_element.serp_item.rank_absolute,asc"]]);
  assert.deepEqual(body.filters, [["keyword_data.keyword_info.search_volume", ">=", 10], "and", ["ranked_serp_element.serp_item.rank_absolute", "<=", 50], "and", ["keyword_data.keyword", "not_ilike", "%acme%"]]);
  const sub = (await c.tool("get_ranked_keywords", { projectId: pid, target: "https://example.com/blog/", limit: 5 })).structuredContent;
  assert.deepEqual([sub.scope, sub.target], ["subfolder", "example.com/blog"]);
  assert.ok(JSON.stringify((dfs.stats().bodies["/v3/dataforseo_labs/google/ranked_keywords/live"]!.at(-1) as any).filters).includes("/blog/%"), "subfolder scope becomes provider-side path filters");
  assert.equal((dfs.stats().bodies["/v3/dataforseo_labs/google/ranked_keywords/live"]!.at(-1) as any).target, "example.com");
  assert.ok((await c.tool("get_ranked_keywords", { projectId: pid, target: "example.com", market: { country: "United States" } })).structuredContent.keywords.length > 0);
  assert.ok((await c.tool("get_ranked_keywords", { projectId: pid, target: "example.com", scope: "subfolder" })).isError, "subfolder needs a path");
  const sg = (await c.tool("get_domain_keyword_suggestions", { projectId: pid, domain: "example.com" })).structuredContent;
  assert.deepEqual(Object.keys(sg.keywords[0]), ["keyword", "position", "searchVolume", "traffic", "cpc", "keywordDifficulty"]);
  assert.deepEqual([sg.target, sg.scope], ["example.com", "subdomains"]);
  const comp = (await c.tool("find_serp_competitors", { projectId: pid, keywords: ["a", "b"], excludeDomains: ["wikipedia.org"], sortBy: "avg_position" })).structuredContent.competitors;
  assert.ok(comp.length > 0 && comp.every((x: any) => x.domain !== "wikipedia.org") && comp[0].avg_position <= comp[1].avg_position, "raw provider rows, sorted client-side");
  assert.deepEqual((dfs.stats().bodies["/v3/dataforseo_labs/google/serp_competitors/live"]!.at(-1) as any).item_types, ["organic", "local_pack"]);
  const bo = (await c.tool("get_backlinks_overview", { projectId: pid, target: "example.com" })).structuredContent;
  assert.equal(bo.scope, "subdomains"); assert.equal(bo.target, "example.com");
  assert.equal(typeof bo.overview.overview.summary.backlinks, "number"); assert.ok(bo.overview.overview.trends.length > 0);
  assert.deepEqual([bo.referringDomains.page, bo.referringDomains.pageSize, bo.referringDomains.rows[0].domain], [1, 100, "ref0.org"]);
  assert.match((await c.tool("get_backlinks_overview", { projectId: pid, target: "example.com", scope: "domain" })).structuredContent.scopeNote, /leaves out subdomains/);
  const bsub = (await c.tool("get_backlinks_overview", { projectId: pid, target: "https://example.com/blog/" })).structuredContent;
  assert.deepEqual([bsub.scope, bsub.target, bsub.referringDomains], ["subfolder", "example.com/blog", undefined]);
  assert.match(bsub.scopeNote, /filtering the backlink list/);
  assert.equal((await c.tool("get_backlinks_overview", { projectId: pid, target: "https://example.com/blog/post", scope: "page" })).structuredContent.scope, "exact_url", "legacy 'page' maps to exact_url");
  const bp = (await c.tool("get_backlinks_profile", { projectId: pid, target: "example.com", page: 2, pageSize: 100, sortField: "domainRank", sortOrder: "asc", filters: { linkType: "dofollow", minDomainRank: "100", hideLost: true } })).structuredContent.backlinks;
  assert.deepEqual([bp.page, bp.pageSize, bp.rows.length, bp.totalCount, bp.hasMore], [2, 100, 0, 23, false]);
  const bb = dfs.stats().bodies["/v3/backlinks/backlinks/live"]!.at(-1) as any;
  assert.deepEqual([bb.offset, bb.limit, bb.order_by, bb.mode], [100, 100, ["domain_from_rank,asc"], "one_per_domain"]);
  assert.ok(JSON.stringify(bb.filters).includes('"dofollow","=",true') && JSON.stringify(bb.filters).includes('"domain_from_rank",">=",100'));
  assert.ok(JSON.stringify(bb.filters).includes("backlink_spam_score"), "hideSpam defaults to true");
  const first = (await c.tool("get_backlinks_profile", { projectId: pid, target: "example.com", hideSpam: false })).structuredContent.backlinks;
  assert.deepEqual([first.page, first.pageSize, first.rows.length, first.hasMore], [1, 50, 23, false]);
  assert.deepEqual(Object.keys(first.rows[0]), ["domainFrom", "urlFrom", "urlTo", "anchor", "itemType", "isDofollow", "relAttributes", "rank", "domainFromRank", "pageFromRank", "spamScore", "firstSeen", "lastSeen", "isLost", "isBroken", "linksCount"]);
  const defaults = dfs.stats().bodies["/v3/backlinks/backlinks/live"]!.at(-1) as any;
  assert.deepEqual([defaults.order_by, defaults.limit], [["first_seen,desc"], 50], "schema defaults apply: firstSeen desc, 50 rows");
  assert.ok(!JSON.stringify(defaults.filters ?? null).includes("backlink_spam_score"), "hideSpam:false adds no spam filter");
  const serp = (await c.tool("get_serp_results", { projectId: pid, queries: [{ keyword: "seo tools" }] })).structuredContent.results[0];
  assert.equal(serp.ok, true); assert.equal(serp.items.length, 20, "default depth is 20 rows, features included");
  assert.deepEqual(serp.items[2], { type: "people_also_ask", rank: 3, title: null, url: null, domain: null, description: null }, "SERP features are kept with null fields");
  assert.equal(serp.items[3].rank, 4, "rank is rank_absolute (shifted by the feature row)");
  const loc = (await c.tool("search_serp_locations", { query: "new york", countryCode: "us" })).structuredContent.locations;
  assert.deepEqual(loc.map((l: any) => l.locationCode), [1023191]);
  const locCalls = dfs.stats().byPath["/v3/serp/google/locations/US"];
  await c.tool("search_serp_locations", { query: "texas", countryCode: "US" });
  assert.equal(dfs.stats().byPath["/v3/serp/google/locations/US"], locCalls, "location list is cached");
  assert.ok((await c.tool("search_serp_locations", { query: "x", countryCode: "USA" })).isError);
  const lsrp = (await c.tool("get_serp_results", { projectId: pid, queries: [{ keyword: "k", locationName: "New York,New York,United States" }, { keyword: "k", locationName: "Atlantis" }] })).structuredContent.results;
  assert.equal(lsrp[0].ok, true); assert.equal(lsrp[1].ok, false);
  assert.equal((dfs.stats().bodies["/v3/serp/google/organic/live/advanced"]!.at(-1) as any).location_name, "New York,New York,United States");
});

test("reports and templates: CRUD, sharing, limits", async () => {
  const t = (await c.tool("save_report_template", { projectId: pid, name: "Monthly", description: "d", instructions: "i" })).structuredContent;
  assert.equal(t.created, true);
  assert.equal((await c.tool("save_report_template", { projectId: pid, templateId: t.templateId, name: "Monthly v2", description: "d", instructions: "i2" })).structuredContent.created, false);
  assert.equal((await c.tool("list_report_templates", { projectId: pid })).structuredContent.templates[0].name, "Monthly v2");
  const r = (await c.tool("save_report", { projectId: pid, title: "Q4", summary: "sum", html: "<html><h1>Hi</h1><script>alert(1)</script></html>", templateId: t.templateId })).structuredContent;
  assert.equal(r.created, true); assert.equal(r.htmlBytes, 49);
  const bad = await c.tool("save_report", { projectId: pid, title: "Truncated", summary: "s", html: "<html><body>cut off" });
  assert.match(bad.content[0]!.text, /never closes its <html> tag/);
  assert.match((await c.tool("save_report", { projectId: pid, title: "Q4", summary: "s", html: "<html></html>" })).content[0]!.text, /^A report called "Q4" already exists \(id [0-9a-f-]{36}\)\. Pass reportId to overwrite it, or choose another title\.$/);
  assert.equal((await c.tool("save_report", { projectId: pid, title: "T".repeat(121), summary: "s", html: "<html></html>" })).content[0]!.text, "The title has 121 characters but at most 120 are allowed. Shorten it and try again.");
  assert.match((await c.tool("save_report", { projectId: pid, title: "Big", summary: "s", html: "<html>" + "x".repeat(600_000) + "</html>" })).content[0]!.text, /^The report is 601 KB but the ceiling is 500 KB\./);
  assert.match((await c.tool("save_report", { projectId: pid, reportId: "00000000-0000-0000-0000-000000000000", title: "Z", summary: "s", html: "<html></html>" })).content[0]!.text, /^No report 00000000-0000-0000-0000-000000000000 in this project/);
  assert.ok((await c.tool("save_report", { projectId: pid, title: "x", summary: "s", html: "<html>" + "x".repeat(500_000) + "</html>" })).isError);
  assert.ok((await c.tool("save_report", { projectId: pid, title: "x", summary: "s", html: "<html></html>", templateId: "00000000-0000-0000-0000-000000000000" })).isError);
  const upd = (await c.tool("save_report", { projectId: pid, reportId: r.reportId, title: "Q4 final", summary: "s2", html: "<html><p>2</p></html>" })).structuredContent;
  assert.deepEqual([upd.created, upd.reportId], [false, r.reportId]);
  const g = (await c.tool("get_report", { projectId: pid, reportId: r.reportId, includeHtml: true })).structuredContent.report;
  const withHtml = await c.tool("get_report", { projectId: pid, reportId: r.reportId, includeHtml: true });
  assert.deepEqual([g.title, g.shareUrl, g.templateId, "html" in g], ["Q4 final", null, t.templateId, false]);
  assert.equal(withHtml.content[0]!.text, "<html><p>2</p></html>", "the document is delivered in the text block");
  assert.equal("html" in (await c.tool("get_report", { projectId: pid, reportId: r.reportId })).structuredContent.report, false);
  const sh = (await c.tool("set_report_sharing", { projectId: pid, reportId: r.reportId, public: true })).structuredContent;
  assert.match(sh.shareUrl, /\/s\/[A-Za-z0-9_-]{32}$/);
  assert.equal((await c.tool("set_report_sharing", { projectId: pid, reportId: r.reportId, public: true })).structuredContent.shareUrl, sh.shareUrl, "idempotent token");
  const lst = (await c.tool("list_reports", { projectId: pid, limit: 1 })).structuredContent;
  assert.deepEqual(Object.keys(lst.reports[0]), ["id", "projectId", "title", "summary", "skill", "templateId", "createdBy", "createdByUserId", "sizeBytes", "createdAt", "updatedAt"]);
  assert.equal(typeof lst.reports[0].createdBy, "string");
  assert.deepEqual([lst.totalCount, lst.rowCount, lst.remaining], [1, 1, 9999]);
  assert.equal((await c.tool("set_report_sharing", { projectId: pid, reportId: r.reportId, public: false })).structuredContent.shareUrl, null);
  assert.equal((await c.tool("delete_report", { projectId: pid, reportId: r.reportId })).structuredContent.deleted, true);
  assert.equal((await c.tool("get_report", { projectId: pid, reportId: r.reportId })).content[0]!.text, `No report ${r.reportId} in this project. Call list_reports to see what exists.`);
  assert.equal((await c.tool("delete_report_template", { projectId: pid, templateId: t.templateId })).structuredContent.deleted, true);
  assert.ok((await c.tool("delete_report_template", { projectId: pid, templateId: t.templateId })).isError);
});
