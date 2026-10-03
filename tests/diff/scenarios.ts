import type { Side, Result } from "./lib.ts";
import { startFixtureSite } from "../support/fixture-site.ts";

export type Scenario = {
  name: string;
  run(side: Side): Promise<Record<string, unknown>>;
  /** Steps that are known to differ, with the reason (documented in docs/MATRIX.md). */
  known?: Record<string, string>;
  /** Per-step override: a projection applied to both sides before diffing (default: exact). */
  compare?: Record<string, "exact" | ((v: unknown) => unknown)>;
};

const RUN = Date.now().toString(36);
const proj = async (s: Side, tag: string, extra: Record<string, unknown> = {}) => {
  const r = await s.call("create_project", { name: `diff-${RUN}-${tag}`, domain: "example.com", ...extra });
  if (r.isError) throw new Error(`create_project failed on ${s.name}: ${r.text}`);
  return (r.data as any).project.id as string;
};
const out = (r: Result) => ({ isError: r.isError, text: r.isError ? r.text : undefined, data: r.data });
const dataOnly = (r: Result) => ({ isError: r.isError, data: r.data, ...(r.isError ? { text: r.text } : {}) });
/** Only compare success/failure and the error text (for validation scenarios whose wording is the contract). */
const verdict = (r: Result) => ({ isError: r.isError, text: r.isError ? r.text : "ok" });
/** Order-insensitive view of saved-keyword rows (the SOURCE does not define an order among rows saved together). */
const sortedRows = (v: any) => (v?.data?.rows ? { ...v, data: { ...v.data, rows: [...v.data.rows].sort((a: any, b: any) => (a.keyword < b.keyword ? -1 : 1)) } } : v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SCENARIOS: Scenario[] = [
  {
    name: "account",
    async run(s) { return { whoami: out(await s.call("whoami")) }; },
  },
  {
    name: "projects",
    async run(s) {
      const a = await s.call("create_project", { name: `diff-${RUN}-p1`, domain: "HTTPS://WWW.Example.com/path" });
      const b = await s.call("create_project", { name: `  diff-${RUN}-p2  `, locationCode: 2276 });
      const c = await s.call("create_project", { name: `diff-${RUN}-p3`, locationCode: 2250, languageCode: "fr" });
      const list = await s.call("list_projects");
      const mine = (list.data as any).projects.filter((p: any) => p.name.startsWith(`diff-${RUN}-p`)).sort((a: any, b: any) => (a.name < b.name ? -1 : 1));
      return {
        create_with_url_domain: out(a), create_trimmed_name_de_market: out(b), create_explicit_language: out(c),
        list_filtered: { count: mine.length, names: mine.map((p: any) => p.name), rows: mine.map(({ id: _i, url: _u, organizationId: _o, organization: _g, ...rest }: any) => rest) },
        list_text_has_header: /^Projects \(\d+\):/.test(list.text),
        err_empty_name: verdict(await s.call("create_project", { name: "" })),
        err_long_name: verdict(await s.call("create_project", { name: "x".repeat(121) })),
        err_language_without_location: verdict(await s.call("create_project", { name: "x", languageCode: "fr" })),
        err_bad_domain: verdict(await s.call("create_project", { name: "x", domain: "not a domain" })),
        err_unknown_project: verdict(await s.call("get_project_context", { projectId: "00000000-0000-0000-0000-000000000000" })),
      };
    },
    known: {
      list_filtered: "SOURCE list_projects includes organization/organizationId fields (multi-tenant); NEW is single-tenant. Compared after dropping them.",
    },
  },
  {
    name: "project-context",
    async run(s) {
      const pid = await proj(s, "ctx");
      const empty = await s.call("get_project_context", { projectId: pid });
      const upd = await s.call("update_project_context", { projectId: pid, updates: [
        { section: "business_overview", content: "We sell widgets" }, { customSection: "launch-plan", title: "Launch plan", content: "Q4" },
        { addCompetitors: [{ domain: "https://www.Rival.com/x", name: "Rival", notes: "main" }] },
        { addKeyPages: [{ url: "https://example.com/pricing", role: "money", topic: "pricing" }] },
        { appendResearchLog: { summary: "Researched widgets" } } ] });
      const del = await s.call("update_project_context", { projectId: pid, updates: [{ section: "business_overview", content: "" }, { deleteCustomSection: "launch-plan" }, { removeCompetitors: ["rival.com"] }, { removeKeyPages: ["https://example.com/pricing"] }] });
      return {
        empty: dataOnly(empty), after_update: dataOnly(upd), after_delete: dataOnly(del),
        err_too_long: verdict(await s.call("update_project_context", { projectId: pid, updates: [{ section: "positioning", content: "x".repeat(4001) }] })),
        err_bad_slug: verdict(await s.call("update_project_context", { projectId: pid, updates: [{ customSection: "Bad_Slug", content: "x" }] })),
      };
    },
  },
  {
    name: "saved-keywords",
    compare: { list_after_two_saves: sortedRows as never, list_by_tag_case_insensitive: sortedRows as never, list_search: sortedRows as never, list_final: sortedRows as never },
    async run(s) {
      const pid = await proj(s, "saved");
      const save1 = await s.call("save_keywords", { projectId: pid, keywords: ["Widget  Tools", "widget tools", "gadgets"], tags: ["Alpha", "beta"], metrics: [{ keyword: "gadgets", searchVolume: 900, keywordDifficulty: 33, cpc: 1.5, competition: 0.4, intent: "commercial" }] });
      const save2 = await s.call("save_keywords", { projectId: pid, keywords: ["gadgets"], tags: ["gamma"] });
      const list1 = await s.call("list_saved_keywords", { projectId: pid });
      const rep = await s.call("save_keywords", { projectId: pid, keywords: ["gadgets"], tags: ["only"], tagMode: "replace" });
      const byTag = await s.call("list_saved_keywords", { projectId: pid, tags: ["ONLY"] });
      const search = await s.call("list_saved_keywords", { projectId: pid, search: "WIDGET" });
      const ids = (list1.data as any).rows.map((r: any) => r.id);
      const target = (list1.data as any).rows.find((r: any) => r.keyword === "widget tools").id;
      const rm = await s.call("remove_saved_keywords", { projectId: pid, savedKeywordIds: [target, "missing-id"] });
      return { save1: out(save1), save2: out(save2), list_after_two_saves: dataOnly(list1), save_replace: out(rep), list_by_tag_case_insensitive: dataOnly(byTag), list_search: dataOnly(search), remove: out(rm), list_final: dataOnly(await s.call("list_saved_keywords", { projectId: pid })) };
    },
  },
  {
    name: "keyword-research",
    async run(s) {
      const pid = await proj(s, "kw");
      const strip = (r: Result) => dataOnly(r);
      return {
        labs: strip(await s.call("research_keywords", { projectId: pid, seeds: [{ seed: "seo tools" }], resultLimit: 150 })),
        labs_grouped: strip(await s.call("research_keywords", { projectId: pid, seeds: [{ seed: "seo tools" }], groupKeywords: true })),
        clickstream: strip(await s.call("research_keywords", { projectId: pid, seeds: [{ seed: "seo tools" }], includeClickstreamData: true })),
        fallback_no_labs_data: strip(await s.call("research_keywords", { projectId: pid, seeds: [{ seed: "nodata thing" }] })),
        iceland_market: strip(await s.call("research_keywords", { projectId: pid, seeds: [{ seed: "seo tools", locationCode: 2352, languageCode: "is" }] })),
        metrics: strip(await s.call("get_keyword_metrics", { projectId: pid, keywords: ["b kw", "a kw", "a kw"] })),
        metrics_trends: strip(await s.call("get_keyword_metrics", { projectId: pid, keywords: ["b kw", "a kw"], includeMonthlyTrends: true, sortBy: "keyword_difficulty" })),
      };
    },
  },
  {
    name: "domain-analysis",
    async run(s) {
      const pid = await proj(s, "dom");
      return {
        overview_bare: dataOnly(await s.call("get_domain_overview", { projectId: pid, domain: "example.com" })),
        overview_url: dataOnly(await s.call("get_domain_overview", { projectId: pid, domain: "https://www.example.com/blog/" })),
        ranked: dataOnly(await s.call("get_ranked_keywords", { projectId: pid, target: "example.com", limit: 10 })),
        ranked_filters: dataOnly(await s.call("get_ranked_keywords", { projectId: pid, target: "example.com", limit: 5, offset: 5, sortBy: "rank", minSearchVolume: 500, maxRank: 10 })),
        suggestions: dataOnly(await s.call("get_domain_keyword_suggestions", { projectId: pid, domain: "example.com" })),
        competitors: dataOnly(await s.call("find_serp_competitors", { projectId: pid, keywords: ["a", "b"], excludeDomains: ["wikipedia.org"] })),
      };
    },
  },
  {
    name: "backlinks",
    async run(s) {
      const pid = await proj(s, "bl");
      return {
        overview: dataOnly(await s.call("get_backlinks_overview", { projectId: pid, target: "example.com" })),
        overview_subfolder: dataOnly(await s.call("get_backlinks_overview", { projectId: pid, target: "https://example.com/blog/" })),
        profile: dataOnly(await s.call("get_backlinks_profile", { projectId: pid, target: "example.com", pageSize: 10 })),
        profile_page2_filtered: dataOnly(await s.call("get_backlinks_profile", { projectId: pid, target: "example.com", page: 2, pageSize: 5, sortField: "domainRank", sortOrder: "asc", filters: { linkType: "dofollow" } })),
      };
    },
  },
  {
    name: "serp",
    async run(s) {
      const pid = await proj(s, "serp");
      return {
        results: dataOnly(await s.call("get_serp_results", { projectId: pid, queries: [{ keyword: "seo tools" }, { keyword: "unranked thing" }], depth: 10 })),
        locations: dataOnly(await s.call("search_serp_locations", { query: "new york", countryCode: "US" })),
        locations_none: dataOnly(await s.call("search_serp_locations", { query: "zzzz", countryCode: "US" })),
      };
    },
  },
  {
    name: "rank-tracking",
    async run(s) {
      const pid = await proj(s, "rank");
      const created = await s.call("create_rank_tracker", { projectId: pid, devices: "both", serpDepth: 20, scheduleInterval: "weekly" });
      const trackerId = (created.data as any).trackerId;
      const added = await s.call("add_rank_tracking_keywords", { projectId: pid, trackerId, keywords: ["seo tools", "Seo Tools", "unranked thing"] });
      const estimate = await s.call("estimate_rank_tracker_cost", { projectId: pid, trackerId, additionalKeywordCount: 2 });
      const tooCheap = await s.call("run_rank_tracker", { projectId: pid, trackerId, maxCostCredits: 1 });
      const started = await s.call("run_rank_tracker", { projectId: pid, trackerId, maxCostCredits: 1000 });
      let got: Result = await s.call("get_rank_tracker", { projectId: pid, trackerId });
      for (let i = 0; i < 80 && !["completed", "failed"].includes((got.data as any)?.results?.run?.status); i++) { await wait(250); got = await s.call("get_rank_tracker", { projectId: pid, trackerId }); }
      const list = await s.call("get_rank_tracker", { projectId: pid });
      return { created: out(created), added: out(added), estimate: out(estimate), run_over_budget: verdict(tooCheap), started: out(started), result: dataOnly(got), list_configs: dataOnly(list), unknown_tracker: verdict(await s.call("get_rank_tracker", { projectId: pid, trackerId: "00000000-0000-0000-0000-000000000000" })) };
    },
  },
  {
    name: "reports",
    known: { shared: "Public sharing is disabled by default in both; the refusal wording differs (SOURCE: hosted-only; NEW: ENABLE_PUBLIC_SHARING)." },
    async run(s) {
      const pid = await proj(s, "rep");
      const tpl = await s.call("save_report_template", { projectId: pid, name: "Monthly", description: "d", instructions: "i" });
      const tplId = (tpl.data as any).templateId;
      const rep = await s.call("save_report", { projectId: pid, title: "Q4", summary: "sum", html: "<html><h1>Hi</h1></html>", templateId: tplId });
      const repId = (rep.data as any).reportId;
      const upd = await s.call("save_report", { projectId: pid, reportId: repId, title: "Q4 final", summary: "s2", html: "<html><p>2</p></html>" });
      const share = await s.call("set_report_sharing", { projectId: pid, reportId: repId, public: true });
      return {
        template: out(tpl), templates: dataOnly(await s.call("list_report_templates", { projectId: pid })), report: out(rep), updated: out(upd),
        get_with_html: dataOnly(await s.call("get_report", { projectId: pid, reportId: repId, includeHtml: true })),
        get_no_html: dataOnly(await s.call("get_report", { projectId: pid, reportId: repId })),
        shared: out(share), list: dataOnly(await s.call("list_reports", { projectId: pid })),
        unshared: out(await s.call("set_report_sharing", { projectId: pid, reportId: repId, public: false })),
        deleted: out(await s.call("delete_report", { projectId: pid, reportId: repId })),
        get_deleted: verdict(await s.call("get_report", { projectId: pid, reportId: repId })),
        tpl_deleted: out(await s.call("delete_report_template", { projectId: pid, templateId: tplId })),
      };
    },
  },
  {
    name: "protocol",
    known: { initialize_shape: "serverInfo name/title/version/websiteUrl/icons carry the SOURCE product's branding; NEW reports its own name and omits websiteUrl/icons." },
    async run(s) {
      const init = (await s.rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d", version: "1" } } })) as any;
      return {
        initialize_shape: { protocolVersion: init.result.protocolVersion, capabilities: init.result.capabilities, hasInstructions: typeof init.result.instructions === "string", serverInfoKeys: Object.keys(init.result.serverInfo).sort() },
        unknown_method: await s.rpc({ jsonrpc: "2.0", id: 2, method: "nope" }),
        unknown_tool: await s.rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } }),
        ping: await s.rpc({ jsonrpc: "2.0", id: 4, method: "ping" }),
        health_shape: (await (await s.http("/api/health")).json() as any).status,
      };
    },
  },
];

const FAKE = `http://127.0.0.1:${process.env.FAKE_PORT ?? 4010}`;
const setFake = (b: object) => fetch(`${FAKE}/__control`, { method: "POST", body: JSON.stringify(b) });

SCENARIOS.push(
  {
    name: "provider-failures",
    async run(s) {
      const pid = await proj(s, "pf");
      const out: Record<string, unknown> = {};
      for (const mode of ["http503", "http401", "balance", "invalid_field", "badjson"]) {
        await setFake({ mode });
        out[`${mode}:overview`] = verdict(await s.call("get_domain_overview", { projectId: pid, domain: `${mode.replace("_", "-")}-a.com` }));
        out[`${mode}:metrics`] = verdict(await s.call("get_keyword_metrics", { projectId: pid, keywords: [`${mode} kw`] }));
        out[`${mode}:ranked`] = verdict(await s.call("get_ranked_keywords", { projectId: pid, target: `${mode.replace("_", "-")}-b.com` }));
        out[`${mode}:backlinks`] = { isError: (await s.call("get_backlinks_overview", { projectId: pid, target: `${mode.replace("_", "-")}-c.com` })).isError };
        out[`${mode}:serp`] = dataOnly(await s.call("get_serp_results", { projectId: pid, queries: [{ keyword: `${mode} q` }] }));
        out[`${mode}:research`] = dataOnly(await s.call("research_keywords", { projectId: pid, seeds: [{ seed: `${mode} seed` }] }));
      }
      await setFake({ mode: "ok" });
      return out;
    },
  },
  {
    name: "validation-sweep",
    async run(s) {
      const pid = await proj(s, "val");
      const U = "00000000-0000-0000-0000-000000000000";
      const cases: [string, Record<string, unknown>][] = [
        ["save_keywords", { projectId: pid }], ["save_keywords", { projectId: pid, keywords: ["a"], tags: ["x".repeat(65)] }], ["save_keywords", { projectId: pid, keywords: ["a"], tagMode: "merge" }],
        ["list_saved_keywords", { projectId: pid, limit: 7 }], ["list_saved_keywords", { projectId: pid, tags: "x" }], ["remove_saved_keywords", { projectId: pid, savedKeywordIds: [] }],
        ["research_keywords", { projectId: pid, seeds: [] }], ["research_keywords", { projectId: pid, seeds: [{ seed: "" }] }], ["research_keywords", { projectId: pid, seeds: Array.from({ length: 6 }, (_, i) => ({ seed: `s${i}` })) }],
        ["get_keyword_metrics", { projectId: pid, keywords: [] }], ["get_keyword_metrics", { projectId: pid, keywords: ["a"], sortBy: "volume" }],
        ["get_domain_overview", { projectId: pid }], ["get_domain_overview", { projectId: pid, domain: "example.por" }], ["get_domain_overview", { projectId: pid, domain: "example.com", scope: "page" }], ["get_domain_overview", { projectId: pid, domain: "example.com", scope: "subfolder" }],
        ["get_ranked_keywords", { projectId: pid, target: "example.com", limit: 101 }], ["get_ranked_keywords", { projectId: pid, target: "example.com", maxRank: 0 }], ["get_ranked_keywords", { projectId: pid, target: "example.com", excludeBrandTerms: [] }],
        ["get_backlinks_overview", { projectId: pid, target: "not a domain" }], ["get_backlinks_profile", { projectId: pid, target: "example.com", pageSize: 25 }], ["get_backlinks_profile", { projectId: pid, target: "example.com", page: 0 }],
        ["get_serp_results", { projectId: pid, queries: [] }], ["get_serp_results", { projectId: pid, queries: [{ keyword: "a" }], depth: 5 }], ["get_serp_results", { projectId: pid, queries: [{ keyword: "a" }], depth: 15 }], ["get_serp_results", { projectId: pid, queries: [{ keyword: "a", languageCode: "xx" }] }],
        ["search_serp_locations", { query: "x", countryCode: "USA" }], ["search_serp_locations", { query: "", countryCode: "US" }],
        ["create_rank_tracker", { projectId: pid, serpDepth: 5 }], ["create_rank_tracker", { projectId: pid, serpDepth: 45 }], ["create_rank_tracker", { projectId: pid, devices: "tablet" }], ["create_rank_tracker", { projectId: pid, scheduleInterval: "hourly" }],
        ["add_rank_tracking_keywords", { projectId: pid, trackerId: U, keywords: [] }], ["add_rank_tracking_keywords", { projectId: pid, trackerId: U, keywords: ["a"] }], ["remove_rank_tracking_keywords", { projectId: pid, trackerId: U, keywordIds: ["x"] }],
        ["estimate_rank_tracker_cost", { projectId: pid, trackerId: U }], ["run_rank_tracker", { projectId: pid, trackerId: U }], ["run_rank_tracker", { projectId: pid, trackerId: U, maxCostCredits: 5 }],
        ["run_site_audit", { projectId: pid, url: "https://example.com", maxPages: 5 }],
        ["get_audit_status", { projectId: pid }], ["get_audit_issues", { projectId: pid, severity: "high" }], ["get_audit_pages", { projectId: pid, fetchClass: "weird" }], ["delete_site_audit", { projectId: pid, auditId: "nope" }],
        ["save_report", { projectId: pid, title: "", summary: "s", html: "<html></html>" }], ["save_report", { projectId: pid, title: "t", summary: "s" }], ["get_report", { projectId: pid, reportId: "nope" }], ["delete_report", { projectId: pid, reportId: U }], ["set_report_sharing", { projectId: pid, reportId: U, public: "yes" }],
        ["save_report_template", { projectId: pid, name: "", description: "d", instructions: "i" }], ["delete_report_template", { projectId: pid, templateId: U }],
        ["get_project_context", {}], ["get_project_context", { projectId: "" }], ["update_project_context", { projectId: pid, updates: [] }], ["update_project_context", { projectId: pid, updates: [{ section: "other", content: "x" }] }], ["update_project_context", { projectId: pid, updates: [{ addCompetitors: [] }] }],
        ["list_reports", { projectId: pid, limit: 51 }], ["list_reports", { projectId: pid, offset: -1 }],
      ];
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [tool, args] of cases) out[`${String(++n).padStart(2, "0")}:${tool}`] = verdict(await s.call(tool, args));
      return out;
    },
  },
  {
    name: "google-not-connected",
    // Neither server has Google credentials in this run, so both must answer every Google tool with a structured
    // "not configured" / "not connected" result rather than an error. Live Google behaviour needs a real consent
    // and is covered by tests/google.test.ts against a fake Google.
    known: {
      search_console: "Same structured reason code; wording and the setup-docs location differ.",
      inspect_urls: "Same structured reason code; wording and the setup-docs location differ.",
    },
    async run(s) {
      const pid = await proj(s, "goog");
      const strip = (r: Result) => ({ isError: r.isError, data: r.data ? { ...(r.data as any), meta: undefined, setupDocsUrl: undefined } : null });
      const out: Record<string, unknown> = {
        search_console: strip(await s.call("get_search_console_performance", { projectId: pid })),
        inspect_urls: strip(await s.call("inspect_urls", { projectId: pid, urls: ["https://example.com/"] })),
        err_both_dates: verdict(await s.call("get_search_console_performance", { projectId: pid, startDate: "2026-09-01" })),
      };
      for (const t of ["get_google_analytics_organic_landing_pages", "get_google_analytics_page_performance", "get_google_analytics_key_events", "get_google_analytics_organic_overview", "get_google_analytics_traffic_acquisition", "get_google_analytics_ecommerce_performance", "get_google_analytics_site_search", "get_google_analytics_audience_breakdown", "get_google_analytics_measurement_health", "get_search_opportunities"])
        out[t] = strip(await s.call(t, { projectId: pid }));
      out.ga4_bad_limit = verdict(await s.call("get_google_analytics_key_events", { projectId: pid, limit: 0 }));
      out.ga4_unknown_arg = verdict(await s.call("get_google_analytics_key_events", { projectId: pid, bogus: 1 }));
      return out;
    },
  },
  {
    name: "site-audit",
    // The SOURCE refuses every private/loopback target (CRAWL_TARGET_BLOCKED) and no public test site is reachable
    // offline, so a crawl cannot be compared against it. The refusal behaviour itself is compared; crawl behaviour is
    // covered by tests/audit.test.ts against a local fixture site.
    known: { refuse_private: "Both refuse private targets; wording differs (SOURCE: bare code CRAWL_TARGET_BLOCKED; NEW: a descriptive sentence).", refuse_metadata: "Same as refuse_private (cloud-metadata address)." },
    async run(s) {
      const pid = await proj(s, "audit");
      return {
        refuse_private: verdict(await s.call("run_site_audit", { projectId: pid, url: "http://127.0.0.1:9/", maxPages: 50 })),
        refuse_metadata: verdict(await s.call("run_site_audit", { projectId: pid, url: "http://169.254.169.254/latest/meta-data", maxPages: 50 })),
        crawl_comparison: { __not_testable: "SOURCE blocks private targets; no public host is reachable offline. NEW's crawler is covered by tests/audit.test.ts." },
      };
    },
  },
);

SCENARIOS.push(
  {
    name: "local-business-data",
    async run(s) {
      const pid = await proj(s, "local");
      const near = { latitude: 40.7128, longitude: -74.006, radiusKm: 5 };
      const call = async (tool: string, args: Record<string, unknown>) => dataOnly(await s.call(tool, { projectId: pid, ...args }));
      return {
        profile_by_name: await call("get_business_profile", { businessName: "Joe's Pizza" }),
        profile_by_cid_near: await call("get_business_profile", { cid: "222", near }),
        profile_by_place_id: await call("get_business_profile", { placeId: "ChIJ-pipes", locationCode: 2840 }),
        profile_not_found: await call("get_business_profile", { businessName: "Nobody Here" }),
        err_two_identifiers: verdict(await s.call("get_business_profile", { projectId: pid, businessName: "a", cid: "1" })),
        err_no_identifier: verdict(await s.call("get_business_profile", { projectId: pid })),
        questions: await call("get_google_business_questions", { businessName: "Joe's Pizza", near }),
        questions_none: await call("get_google_business_questions", { businessName: "Nobody Here", near }),
        questions_depth: await call("get_google_business_questions", { cid: "111", near: { latitude: 1, longitude: 2 }, depth: 30 }),
        categories_all: await call("list_business_categories", {}),
        categories_query: await call("list_business_categories", { query: "PIZZA", limit: 1 }),
        categories_none: await call("list_business_categories", { query: "zzzz" }),
        err_categories_limit: verdict(await s.call("list_business_categories", { projectId: pid, limit: 201 })),
        listings_basic: await call("search_local_businesses", { near: { latitude: 40.7, longitude: -74, radiusKm: 5 } }),
        listings_filtered: await call("search_local_businesses", { near: { latitude: 40.7, longitude: -74, radiusKm: 4.6 }, categories: ["pizza_restaurant"], minRating: 4, minReviews: 50, isClaimed: false, sortBy: "reviews", limit: 5 }),
        listings_sorted_rating: await call("search_local_businesses", { near: { latitude: 40.7, longitude: -74, radiusKm: 1 }, sortBy: "rating" }),
        listings_paged: await call("search_local_businesses", { near: { latitude: 40.7, longitude: -74, radiusKm: 5 }, limit: 2, offset: 2 }),
        listings_none: await call("search_local_businesses", { near: { latitude: 40.7, longitude: -74, radiusKm: 5 }, query: "nothing-here" }),
        err_listings_rating: verdict(await s.call("search_local_businesses", { projectId: pid, near: { latitude: 40, longitude: -74, radiusKm: 5 }, minRating: 0.5 })),
        err_listings_no_near: verdict(await s.call("search_local_businesses", { projectId: pid })),
        serp_maps: await call("get_local_serp_results", { keyword: "pizza", near: { latitude: 40.7, longitude: -74, zoom: 14 } }),
        serp_finder_desktop: await call("get_local_serp_results", { keyword: "pizza", near: { latitude: 40.7, longitude: -74 }, searchType: "local_finder", device: "desktop", depth: 5 }),
        serp_none: await call("get_local_serp_results", { keyword: "pizza [nothing]", near: { latitude: 40.7, longitude: -74 } }),
        err_serp_zoom: verdict(await s.call("get_local_serp_results", { projectId: pid, keyword: "x", near: { latitude: 40, longitude: -74, zoom: 30 } })),
        unknown_project: verdict(await s.call("list_business_categories", { projectId: "00000000-0000-0000-0000-000000000000" })),
      };
    },
  },
  {
    name: "local-queued-tasks",
    // The task id is provider-generated, so it is reduced to its prefix before comparing.
    compare: { reviews: (v: any) => scrubTask(v), reviews_other: (v: any) => scrubTask(v), updates: (v: any) => scrubTask(v), updates_empty: (v: any) => scrubTask(v), updates_none: (v: any) => scrubTask(v) },
    async run(s) {
      const pid = await proj(s, "queued");
      const call = async (tool: string, args: Record<string, unknown>) => dataOnly(await s.call(tool, { projectId: pid, ...args }));
      const rev = await s.call("get_business_reviews", { projectId: pid, businessName: "Joe's Pizza" });
      const taskId = (rev.data as any)?.taskId as string | undefined;
      return {
        reviews: dataOnly(rev),
        reviews_other: await call("get_business_reviews", { cid: "111", includeOtherSources: true, depth: 10 }),
        reviews_sorted_text: { ...(await call("get_business_reviews", { placeId: "ChIJ-slice", sortBy: "lowest_rating", depth: 40 })) , data: undefined },
        reviews_none: scrubTask(await call("get_business_reviews", { businessName: "Nobody Here" })),
        resume: taskId ? scrubTask(await call("get_business_reviews", { taskId })) : "no task",
        err_bad_task_id: verdict(await s.call("get_business_reviews", { projectId: pid, taskId: "nonsense" })),
        err_two_ids: verdict(await s.call("get_business_reviews", { projectId: pid, cid: "1", placeId: "p" })),
        err_depth: verdict(await s.call("get_business_reviews", { projectId: pid, businessName: "a", depth: 5 })),
        updates: await call("get_business_updates", { businessName: "Joe's Pizza", near: { latitude: 40.7, longitude: -74 } }),
        updates_empty: await call("get_business_updates", { businessName: "Slice Heaven", depth: 10 }),
        updates_none: scrubTask(await call("get_business_updates", { businessName: "Nobody Here" })),
        err_updates_reviews_task: verdict(await s.call("get_business_updates", { projectId: pid, taskId: "google:abc" })),
      };
    },
  },
  {
    name: "local-rank-grid",
    async run(s) {
      const pid = await proj(s, "grid");
      const call = async (tool: string, args: Record<string, unknown>) => dataOnly(await s.call(tool, { projectId: pid, ...args }));
      return {
        grid_default: await call("get_local_rank_grid", { keyword: "pizza", target: { cid: "111" }, center: { latitude: 40.7, longitude: -74 } }),
        grid_by_name_5: await call("get_local_rank_grid", { keyword: "pizza", target: { name: "slice" }, center: { latitude: 40.74, longitude: -74.0 }, gridSize: 5, spacingKm: 3.5, device: "desktop" }),
        grid_by_place_zoom: await call("get_local_rank_grid", { keyword: "pizza", target: { placeId: "ChIJ-joes" }, center: { latitude: 40.74, longitude: -74 }, spacingKm: 0.25, zoom: 9 }),
        grid_not_found: await call("get_local_rank_grid", { keyword: "pizza", target: { cid: "nope" }, center: { latitude: 10, longitude: 20 } }),
        grid_polar: await call("get_local_rank_grid", { keyword: "pizza", target: { cid: "111" }, center: { latitude: 89.9, longitude: 0 }, spacingKm: 10 }),
        grid_all_fail: verdict(await s.call("get_local_rank_grid", { projectId: pid, keyword: "pizza [serpfail]", target: { cid: "111" }, center: { latitude: 40.7, longitude: -74 } })),
        err_no_target: verdict(await s.call("get_local_rank_grid", { projectId: pid, keyword: "pizza", target: {}, center: { latitude: 40.7, longitude: -74 } })),
        err_grid_size: verdict(await s.call("get_local_rank_grid", { projectId: pid, keyword: "pizza", target: { cid: "1" }, center: { latitude: 40.7, longitude: -74 }, gridSize: 4 })),
      };
    },
  },
);

function scrubTask(v: any): any {
  const walk = (x: any): any => (typeof x === "string" ? x.replace(/\b(google|extended):[0-9a-zA-Z-]+/g, "$1:<id>").replace(/\bbd-\d+-\d+-\d+\b/g, "<id>").replace(/taskId "[^"]+"/g, 'taskId "<id>"') : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, val]) => [k, k === "taskId" ? String(val).replace(/^(google|extended):.*/, "$1:<id>").replace(/^bd-.*/, "<id>") : walk(val)])) : x);
  return walk(v);
}
