import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeDfs, type FakeDfs } from "./support/fake-dataforseo.ts";
import { makeClient, makeCtx } from "./support/harness.ts";

let dfs: FakeDfs;
let c: ReturnType<typeof makeClient>;
let pid: string;
before(async () => { dfs = await startFakeDfs(); });
after(() => dfs.close());
beforeEach(async () => {
  dfs.reset();
  c = makeClient(makeCtx({ dfsUrl: dfs.url }));
  pid = (await c.tool("create_project", { name: "F", domain: "example.com" })).structuredContent.project.id;
});

const READ_TOOLS: [string, Record<string, unknown>][] = [
  ["get_keyword_metrics", { keywords: ["a"] }], ["get_domain_overview", { domain: "example.com" }],
  ["get_ranked_keywords", { target: "example.com" }], ["get_domain_keyword_suggestions", { domain: "example.com" }],
  ["find_serp_competitors", { keywords: ["a"] }], ["get_backlinks_overview", { target: "example.com" }],
  ["get_backlinks_profile", { target: "example.com" }], ["search_serp_locations", { query: "a", countryCode: "US" }],
];

test("no API key: every provider-backed tool says exactly what to set, and spends nothing", async () => {
  const nk = makeClient(makeCtx({ noKey: true, dfsUrl: dfs.url }));
  const p = (await nk.tool("create_project", { name: "N" })).structuredContent.project.id;
  for (const [name, args] of [...READ_TOOLS, ["research_keywords", { seeds: [{ seed: "a" }] }], ["get_serp_results", { queries: [{ keyword: "a" }] }]] as const) {
    const r = await nk.tool(name, { projectId: p, ...args });
    assert.ok(r.isError, name); assert.match(r.content[0]!.text, /DATAFORSEO_API_KEY/, name);
  }
  assert.equal(dfs.stats().total, 0);
});
for (const [mode, re] of [["http503", /^DataForSEO HTTP 503 on \/v3\//], ["http401", /^DataForSEO HTTP 401 on \/v3\//], ["balance", /Payment Required|billing or balance/], ["invalid_field", /^Invalid Field/], ["badjson", /not valid JSON/]] as const) {
  test(`provider failure "${mode}": tools return isError with a specific message and never throw`, async () => {
    dfs.setMode(mode);
    for (const [name, args] of READ_TOOLS.filter(([n]) => n !== "search_serp_locations")) {
      const r = await c.tool(name, { projectId: pid, ...args });
      assert.ok(r.isError, `${name} should fail`); assert.match(r.content[0]!.text, re, name);
    }
    dfs.setMode("ok");
    assert.ok(!(await c.tool("get_domain_overview", { projectId: pid, domain: "example.com" })).isError, "recovers after the outage");
  });
}
test("per-item failures: SERP and research report ok:false per query instead of failing the whole call", async () => {
  dfs.setMode("balance");
  const s = await c.tool("get_serp_results", { projectId: pid, queries: [{ keyword: "a" }, { keyword: "b" }] });
  assert.ok(s.structuredContent.results.every((r: any) => r.ok === false && /Payment Required/.test(r.error)));
  dfs.setMode("http503");
  const r = await c.tool("research_keywords", { projectId: pid, seeds: [{ seed: "a" }, { seed: "b" }] });
  assert.ok(!r.isError, "503 is per-seed, not fatal");
  assert.ok(r.structuredContent.results.every((x: any) => x.ok === false && /HTTP 503/.test(x.error)));
});
test("provider timeout is reported, not hung", async () => {
  const slow = makeClient(makeCtx({ dfsUrl: dfs.url }));
  (slow.ctx.dfs.opts as { timeoutMs: number }).timeoutMs = 150;
  const p = (await slow.tool("create_project", { name: "T" })).structuredContent.project.id;
  dfs.setMode("slow", 1000);
  const t0 = Date.now();
  const r = await slow.tool("get_domain_overview", { projectId: p, domain: "example.com" });
  assert.ok(r.isError); assert.match(r.content[0]!.text, /request failed|timeout|abort/i); assert.ok(Date.now() - t0 < 900);
});
test("provider unreachable (connection refused)", async () => {
  const dead = makeClient(makeCtx({ dfsUrl: "http://127.0.0.1:1" }));
  const p = (await dead.tool("create_project", { name: "D" })).structuredContent.project.id;
  const r = await dead.tool("get_keyword_metrics", { projectId: p, keywords: ["a"] });
  assert.ok(r.isError); assert.match(r.content[0]!.text, /DataForSEO request failed/);
});
test("wrong credentials against the real fake are surfaced as an auth problem", async () => {
  const bad = makeClient(makeCtx({ dfsUrl: dfs.url, DATAFORSEO_API_KEY: Buffer.from("x:y").toString("base64") }));
  const p = (await bad.tool("create_project", { name: "B" })).structuredContent.project.id;
  const r = await bad.tool("get_domain_overview", { projectId: p, domain: "example.com" });
  assert.ok(r.isError); assert.match(r.content[0]!.text, /^DataForSEO HTTP 401 on /);
});
test("tools never cross project boundaries", async () => {
  const other = (await c.tool("create_project", { name: "Other" })).structuredContent.project.id;
  await c.tool("save_keywords", { projectId: pid, keywords: ["secret kw"] });
  const id = (await c.tool("list_saved_keywords", { projectId: pid })).structuredContent.rows[0].id;
  assert.equal((await c.tool("remove_saved_keywords", { projectId: other, savedKeywordIds: [id] })).structuredContent.deletedCount, 0);
  assert.equal((await c.tool("list_saved_keywords", { projectId: other })).structuredContent.totalCount, 0);
  const t = (await c.tool("create_rank_tracker", { projectId: pid })).structuredContent.trackerId;
  assert.equal((await c.tool("get_rank_tracker", { projectId: other, trackerId: t })).content[0]!.text, "Rank tracking config not found");
  assert.equal((await c.tool("add_rank_tracking_keywords", { projectId: other, trackerId: t, keywords: ["x"] })).content[0]!.text, "Rank tracking config not found");
  const rep = (await c.tool("save_report", { projectId: pid, title: "t", summary: "s", html: "<html></html>" })).structuredContent.reportId;
  assert.equal((await c.tool("get_report", { projectId: other, reportId: rep })).content[0]!.text, `No report ${rep} in this project. Call list_reports to see what exists.`);
  assert.equal((await c.tool("delete_report", { projectId: other, reportId: rep })).content[0]!.text, `No report ${rep} in this project. Call list_reports to see what exists.`);
});
test("SQL-injection-shaped and unicode inputs are stored and returned verbatim", async () => {
  const nasty = ["Robert'); DROP TABLE saved_keywords;--", "日本語 キーワード", "emoji 🚀 test", "a%b_c\\d"];
  await c.tool("save_keywords", { projectId: pid, keywords: nasty, tags: ["tag'; --"] });
  const rows = (await c.tool("list_saved_keywords", { projectId: pid })).structuredContent.rows.map((r: any) => r.keyword).sort();
  assert.deepEqual(rows, nasty.map((k) => k.toLowerCase()).sort());
  assert.equal((await c.tool("list_saved_keywords", { projectId: pid, search: "a%b_c\\d" })).structuredContent.rows.length, 1);
});
test("large inputs: 100 keywords per call and 1000 saved keywords round-trip", async () => {
  for (let i = 0; i < 10; i++) await c.tool("save_keywords", { projectId: pid, keywords: Array.from({ length: 100 }, (_, j) => `bulk ${i}-${j}`) });
  assert.equal((await c.tool("list_saved_keywords", { projectId: pid, limit: 250 })).structuredContent.totalCount, 1000);
  assert.equal((await c.tool("list_saved_keywords", { projectId: pid, limit: 250 })).structuredContent.rows.length, 250);
});
test("concurrent writers do not corrupt state", async () => {
  await Promise.all(Array.from({ length: 25 }, (_, i) => c.tool("save_keywords", { projectId: pid, keywords: ["shared", `own ${i}`], tags: ["t"] })));
  const l = (await c.tool("list_saved_keywords", { projectId: pid })).structuredContent;
  assert.equal(l.totalCount, 26); assert.deepEqual(l.tags, [{ name: "t", keywordCount: 26 }]);
});

test("a 403 from DataForSEO carries the provider's reason (e.g. an unverified account) so users know what to fix", async () => {
  const srv = (await import("node:http")).createServer((_q, res) => { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ status_code: 40104, status_message: "Please verify your account before using the API." })); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const cl = makeClient(makeCtx({ dfsUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}` }));
    const p = (await cl.tool("create_project", { name: "V" })).structuredContent.project.id;
    const r = await cl.tool("get_keyword_metrics", { projectId: p, keywords: ["a"] });
    assert.ok(r.isError); assert.match(r.content[0]!.text, /^DataForSEO HTTP 403 on \/v3\/dataforseo_labs\/google\/keyword_overview\/live: Please verify your account/);
  } finally { srv.closeAllConnections(); srv.close(); }
});

const control = (b: object) => fetch(`${dfs.url}/__control`, { method: "POST", body: JSON.stringify(b) });
test("a temporary 'access paused' refusal from DataForSEO is retried with backoff (a refused call is never billed); persistent pauses surface the provider's message", async () => {
  const cl = makeClient(makeCtx({ dfsUrl: dfs.url, DFS_RETRY_DELAY_MS: "10" }));
  const p = (await cl.tool("create_project", { name: "R", domain: "example.com" })).structuredContent.project.id;
  await control({ pauseNext: 2 });
  const ok = await cl.tool("get_keyword_metrics", { projectId: p, keywords: ["a"] });
  assert.ok(!ok.isError, ok.content[0]!.text);
  assert.equal(dfs.stats().byPath["/v3/dataforseo_labs/google/keyword_overview/live"], 3, "two refusals then success");
  dfs.reset(); await control({ pauseNext: 50 });
  const bad = await cl.tool("get_domain_overview", { projectId: p, domain: "example.com" });
  assert.ok(bad.isError); assert.match(bad.content[0]!.text, /temporarily paused access.*support@dataforseo\.com/);
  assert.equal(dfs.stats().byPath["/v3/dataforseo_labs/google/domain_rank_overview/live"], 4, "gives up after four attempts");
  await control({ pauseNext: 0 });
  assert.ok(!(await cl.tool("get_domain_overview", { projectId: p, domain: "example.com" })).isError, "works again once the pause ends");
});
test("backlinks overview keeps the paid summary when the optional calls are paused, and says what is missing", async () => {
  const cl = makeClient(makeCtx({ dfsUrl: dfs.url, DFS_RETRY_DELAY_MS: "5" }));
  const p = (await cl.tool("create_project", { name: "B", domain: "example.com" })).structuredContent.project.id;
  await control({ pausePaths: ["/v3/backlinks/history/live", "/v3/backlinks/referring_domains/live"] });
  const r = await cl.tool("get_backlinks_overview", { projectId: p, target: "example.com" });
  assert.ok(!r.isError, r.content[0]!.text);
  const d = r.structuredContent;
  assert.equal(typeof d.overview.overview.summary.backlinks, "number"); assert.deepEqual(d.overview.overview.trends, []); assert.equal(d.referringDomains, undefined);
  assert.match(d.scopeNote, /Some details were unavailable and are omitted: trend history .*; referring-domain breakdown/);
  await control({ pausePaths: [] });
  const full = (await cl.tool("get_backlinks_overview", { projectId: p, target: "example.com" })).structuredContent;
  assert.ok(full.overview.overview.trends.length > 0 && full.referringDomains.rows.length > 0 && !full.scopeNote);
  await control({ mode: "http503" });
  assert.ok((await cl.tool("get_backlinks_overview", { projectId: p, target: "example.com" })).isError, "a failing summary still fails the tool");
});

test("prompt explorer: a persistent DataForSEO pause is one clear error for every model, not 'temporarily unavailable' per model; refused calls are not billed", async () => {
  const cl = makeClient(makeCtx({ dfsUrl: dfs.url, DFS_RETRY_DELAY_MS: "5" }));
  const p = (await cl.tool("create_project", { name: "P", domain: "example.com" })).structuredContent.project.id;
  dfs.reset(); await control({ pauseNext: 500 });
  const r = await cl.post(`/api/projects/${p}/ai/prompt`, { prompt: "paused question", models: ["chat_gpt", "claude"] });
  assert.equal(r.status, 503);
  const e = ((await r.json()) as any).error;
  assert.equal(e.code, "UPSTREAM_PAUSED");
  assert.match(e.message, /temporarily paused access.*support@dataforseo\.com/);
  assert.equal(((await (await cl.get("/api/usage")).json()) as any).totalUsd, 0);
  await control({ pauseNext: 0 });
});
