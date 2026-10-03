import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeDfs, type FakeDfs } from "./support/fake-dataforseo.ts";
import { startFakeOpenRouter, type FakeOpenRouter } from "./support/fake-openrouter.ts";
import { makeClient, makeCtx } from "./support/harness.ts";
import { AI_CALL_COST } from "./support/fake-ai.ts";
import { awaitRankRuns } from "../src/services/rankTracking.ts";
import { monthStart } from "../src/services/usage.ts";

const KEY = "sk-or-test-key-1234567890";
let dfs: FakeDfs, or: FakeOpenRouter;
let c: ReturnType<typeof makeClient>, pid: string;
before(async () => { dfs = await startFakeDfs(); or = await startFakeOpenRouter({ apiKey: KEY }); });
after(async () => { await dfs.close(); await or.close(); });
beforeEach(async () => {
  dfs.reset(); or.reset();
  c = makeClient(makeCtx({ dfsUrl: dfs.url, OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: or.url, RANK_POLL_MS: "25", RANK_QUEUE_TIMEOUT_MS: "400" }));
  pid = (await c.tool("create_project", { name: "Acme", domain: "acme.com" })).structuredContent.project.id;
});

let n = 0;
const ask = (project: string, models = ["gemini"]) => c.post(`/api/projects/${project}/ai/prompt`, { prompt: `usage prompt ${++n} ${Math.random()}`, models });
const usage = async (q = "") => (await (await c.get(`/api/usage${q}`)).json()) as any;
const put = (body: unknown) => c.app.request("/api/budgets", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("an empty ledger reports zeros, the current month and no budgets", async () => {
  const u = await usage();
  assert.equal(u.month, monthStart().slice(0, 7));
  assert.deepEqual([u.totalUsd, u.byProvider, u.byFeature, u.byProject, u.daily, u.recent, u.budgets], [0, [], [], [], [], [], []]);
});

test("every billed call is recorded with provider, feature and project; cache hits and refused calls are not", async () => {
  const other = ((await (await c.post("/api/projects", { name: "Other" })).json()) as any).project.id;
  await ask(pid, ["gemini", "claude"]);
  await ask(other);
  await c.tool("get_serp_results", { projectId: pid, queries: [{ keyword: "seo tools" }] });
  await c.post("/api/tools/get_serp_results", { projectId: other, queries: [{ keyword: "more tools" }] });
  const u = await usage();
  assert.deepEqual(u.byFeature.map((f: any) => f.feature).sort(), ["ai_visibility", "serp"]);
  const ai = u.byFeature.find((f: any) => f.feature === "ai_visibility");
  assert.equal(ai.label, "AI visibility");
  assert.equal(ai.calls, 3);
  near(ai.usd, 3 * AI_CALL_COST);
  assert.deepEqual(u.byProvider.map((p: any) => p.provider), ["dataforseo"]);
  assert.equal(u.byProject.length, 2);
  assert.deepEqual(u.byProject.map((p: any) => p.name).sort(), ["Acme", "Other"]);
  near(u.byProject.find((p: any) => p.projectId === pid).usd, 2 * AI_CALL_COST + u.byFeature.find((f: any) => f.feature === "serp").usd / 2);
  const mine = await usage(`?projectId=${pid}`);
  assert.equal(mine.byProject.length, 0);
  near(mine.totalUsd, 2 * AI_CALL_COST + u.byFeature.find((f: any) => f.feature === "serp").usd / 2);
  assert.ok(u.recent.every((r: any) => r.endpoint?.startsWith("/v3/") && r.usd > 0));
  assert.equal(u.daily.length, 1);
  // a free provider call (model catalog) and a failed call add nothing
  const before = u.totalUsd;
  await c.post(`/api/projects/${pid}/ai/prompt`, { prompt: "[fail:gemini] x" + n, models: ["gemini"] });
  near((await usage()).totalUsd, before);
  assert.equal((await usage("?days=1")).totalUsd, before);
});

test("rank-tracking runs are attributed to the project, including the queued background path", async () => {
  const t = (await c.tool("create_rank_tracker", { projectId: pid })).structuredContent.config.id;
  await c.tool("add_rank_tracking_keywords", { projectId: pid, trackerId: t, keywords: ["alpha", "beta"] });
  await c.tool("run_rank_tracker", { projectId: pid, trackerId: t, maxCostCredits: 100000 });
  await awaitRankRuns();
  const u = await usage(`?projectId=${pid}`);
  const f = u.byFeature.find((x: any) => x.feature === "rank_tracking");
  assert.ok(f && f.usd > 0, JSON.stringify(u.byFeature));
  assert.equal(u.byFeature.length, 1, "nothing leaks into another feature");
});

test("assistant spend (OpenRouter) is recorded with its real cost, and the tools it calls are billed to the assistant", async () => {
  const sid = ((await (await c.post(`/api/projects/${pid}/agent/sessions`, {})).json()) as any).session.id;
  or.script({ tools: [{ name: "get_serp_results", args: { queries: [{ keyword: "seo" }] } }], cost: 0.003 }, { text: "Done.", cost: 0.002 });
  const r = await c.post(`/api/projects/${pid}/agent/sessions/${sid}/messages`, { text: "check seo" });
  assert.equal(r.status, 200);
  const u = await usage(`?projectId=${pid}`);
  const or$ = u.byProvider.find((p: any) => p.provider === "openrouter");
  near(or$.usd, 0.005);
  assert.deepEqual(u.byFeature.map((f: any) => f.feature).sort(), ["assistant"], "model cost and the data it bought both count as assistant use");
  assert.ok(u.byProvider.find((p: any) => p.provider === "dataforseo").usd > 0);
});

test("a global monthly budget refuses new paid calls once it is used up, and says so", async () => {
  const set = await put({ monthlyLimitUsd: AI_CALL_COST * 1.5 });
  assert.equal(set.status, 200);
  assert.equal(((await set.json()) as any).budget.status, "ok");
  assert.equal((await ask(pid)).status, 200);
  const second = await ask(pid);
  assert.equal(second.status, 200, "the cap is checked before a call, so the call that crosses it still finishes");
  const stats = dfs.stats().byPath["/v3/ai_optimization/gemini/llm_responses/live"];
  const blocked = await ask(pid);
  assert.equal(blocked.status, 402);
  const e = ((await blocked.json()) as any).error;
  assert.equal(e.code, "BUDGET_EXCEEDED");
  assert.match(e.message, /monthly budget of \$0\.0180 is used up/);
  assert.equal(dfs.stats().byPath["/v3/ai_optimization/gemini/llm_responses/live"], stats, "no provider call was made");
  const tool = await c.tool("get_serp_results", { projectId: pid, queries: [{ keyword: "x" }] }, { skipSchema: true });
  assert.equal(tool.structuredContent.results[0].ok, false, "a tool that reports per-query results says why each one failed");
  assert.match(tool.content[0]!.text, /monthly budget/);
  assert.equal(dfs.stats().byPath["/v3/serp/google/organic/live/advanced"] ?? 0, 0);
  const b = ((await (await c.get("/api/budgets")).json()) as any).budgets;
  assert.equal(b.length, 1);
  assert.equal(b[0].status, "exceeded");
  assert.ok(b[0].percent >= 100);
  // raising the limit re-opens access; removing it too
  await put({ monthlyLimitUsd: 5 });
  assert.equal((await ask(pid)).status, 200);
  await put({ monthlyLimitUsd: null });
  assert.deepEqual(((await (await c.get("/api/budgets")).json()) as any).budgets, []);
});

test("a project budget only stops that project; the assistant is stopped before it calls the model", async () => {
  const other = ((await (await c.post("/api/projects", { name: "Other" })).json()) as any).project.id;
  await put({ projectId: pid, monthlyLimitUsd: 0.01 });
  assert.equal((await ask(pid)).status, 200);
  assert.equal((await ask(pid)).status, 402);
  assert.equal((await ask(other)).status, 200, "other projects keep working");
  const sid = ((await (await c.post(`/api/projects/${pid}/agent/sessions`, {})).json()) as any).session.id;
  or.script({ text: "hi" });
  const r = await c.post(`/api/projects/${pid}/agent/sessions/${sid}/messages`, { text: "hello" });
  assert.equal(r.status, 402);
  assert.equal(or.requests().length, 0, "no model call was made");
  const t = (await (await c.get(`/api/projects/${pid}/agent/sessions/${sid}`)).json()) as any;
  assert.deepEqual(t.messages, [], "a refused turn leaves no transcript");
  const mine = await usage(`?projectId=${pid}`);
  assert.equal(mine.budgets.length, 1);
  assert.equal(mine.budgets[0].projectId, pid);
  // deleting the project removes its budget and keeps its spend as unassigned
  await c.app.request(`/api/projects/${pid}`, { method: "DELETE" });
  assert.deepEqual(((await (await c.get("/api/budgets")).json()) as any).budgets, []);
  const after = await usage();
  assert.ok(after.byProject.some((p: any) => p.projectId === null && p.name === "Unassigned"));
});

test("budget input validation", async () => {
  for (const body of [{}, { monthlyLimitUsd: 0 }, { monthlyLimitUsd: -3 }, { monthlyLimitUsd: "5" }, { monthlyLimitUsd: 2_000_000 }, { monthlyLimitUsd: 0.00001 }, { projectId: 7, monthlyLimitUsd: 5 }]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await put({ projectId: "nope", monthlyLimitUsd: 5 })).status, 404);
  assert.equal((((await (await put({ projectId: pid, monthlyLimitUsd: 12.3456789 })).json()) as any).budget.monthlyLimitUsd), 12.3457);
  assert.equal((await c.get("/api/usage?days=0")).status, 400);
  assert.equal((await c.get("/api/usage?days=abc")).status, 400);
  assert.equal((await c.get("/api/usage?days=400")).status, 400);
  assert.equal((await c.get("/api/usage?projectId=nope")).status, 404);
});

test("budget warning at 80% and the ledger only counts the current month", async () => {
  await ask(pid);
  await put({ monthlyLimitUsd: AI_CALL_COST * 1.2 });
  assert.equal(((await (await c.get("/api/budgets")).json()) as any).budgets[0].status, "warning");
  // spend from an earlier month does not count against this month's budget
  c.ctx.db.prepare("UPDATE usage_events SET created_at='2020-01-15T00:00:00.000Z'").run();
  assert.equal(((await (await c.get("/api/budgets")).json()) as any).budgets[0].spentUsd, 0);
  assert.equal((await ask(pid)).status, 200);
  assert.equal((await usage()).totalUsd, AI_CALL_COST, "the monthly view ignores January 2020");
});

// ---------------- dashboard ----------------

const dash = async (project = pid) => (await (await c.get(`/api/projects/${project}/dashboard`)).json()) as any;

test("dashboard: a fresh project shows its setup steps and costs nothing to open", async () => {
  const bare = (await (await c.post("/api/projects", { name: "Bare" })).json() as any).project.id;
  const before = dfs.stats().total;
  const d = await dash(bare);
  assert.equal(dfs.stats().total, before, "opening the dashboard never calls the provider");
  assert.deepEqual(d.steps.map((s: any) => [s.key, s.done]), [["domain", false], ["keywords", false], ["competitors", false], ["rankings", false], ["audit", false], ["ai", false], ["gsc", false], ["ga4", false], ["budget", false]]);
  assert.equal(d.openSteps, 9);
  assert.deepEqual(d.counts, { savedKeywords: 0, competitors: 0, reports: 0, aiRuns: 0, assistantChats: 0 });
  assert.deepEqual([d.rankings.trackedKeywords, d.rankings.averagePosition, d.audit, d.ai.lastBrand, d.spend.monthUsd], [0, null, null, null, 0]);
  assert.equal((await c.get("/api/projects/nope/dashboard")).status, 404);
});

test("dashboard reflects real progress: keywords, competitors, rankings, audit, AI visibility, spend and budget", async () => {
  await c.tool("save_keywords", { projectId: pid, keywords: ["seo tools", "rank tracker"] });
  await c.tool("update_project_context", { projectId: pid, updates: [{ addCompetitors: [{ domain: "rival.com" }] }] });
  const t = (await c.tool("create_rank_tracker", { projectId: pid, domain: "example.com" })).structuredContent.config.id;
  await c.tool("add_rank_tracking_keywords", { projectId: pid, trackerId: t, keywords: ["alpha", "beta", "unranked thing"] });
  await c.tool("run_rank_tracker", { projectId: pid, trackerId: t, maxCostCredits: 100000 });
  await awaitRankRuns();
  await c.post(`/api/projects/${pid}/ai/brand`, { query: "acme.com", competitors: ["rival.com"] });
  await put({ projectId: pid, monthlyLimitUsd: 50 });
  const d = await dash();
  const done = Object.fromEntries(d.steps.map((s: any) => [s.key, s.done]));
  assert.equal(done.domain, true); assert.equal(done.keywords, true); assert.equal(done.competitors, true); assert.equal(done.rankings, true); assert.equal(done.ai, true); assert.equal(done.budget, true);
  assert.equal(done.audit, false); assert.equal(done.gsc, false);
  assert.equal(d.counts.savedKeywords, 2);
  assert.equal(d.rankings.trackedKeywords, 3);
  assert.ok(d.rankings.ranking >= 1 && d.rankings.ranking < 3, "the 'unranked' keyword is not counted as ranking");
  assert.equal(typeof d.rankings.averagePosition, "number");
  assert.ok(d.rankings.lastCheckedAt);
  assert.equal(d.ai.runs, 1);
  assert.equal(d.ai.lastBrand.query, "acme.com");
  assert.equal(d.ai.lastBrand.totalMentions, 140);
  assert.ok(Math.round(d.ai.lastBrand.sharePct) === 67);
  assert.ok(d.spend.monthUsd > 0);
  assert.equal(d.spend.budget.monthlyLimitUsd, 50);
  assert.equal(d.spend.globalBudget, null);
});

test("dashboard: latest audit summary, ordered by severity, and connection steps", async () => {
  const id = "audit-1";
  const db = c.ctx.db;
  db.prepare("INSERT INTO audits (id,project_id,start_url,status,max_pages,pages_crawled,started_at,completed_at) VALUES (?,?,?,?,?,?,?,?)").run(id, pid, "https://acme.com/", "completed", 50, 12, "2026-01-02T00:00:00.000Z", "2026-01-02T00:05:00.000Z");
  const ins = db.prepare("INSERT INTO audit_issues (id,audit_id,url,type,severity) VALUES (?,?,?,?,?)");
  ins.run("1", id, "https://acme.com/a", "missing_title", "critical"); ins.run("2", id, "https://acme.com/b", "missing_title", "critical");
  ins.run("3", id, "https://acme.com/a", "thin_content", "warning"); ins.run("4", id, "https://acme.com/a", "no_canonical", "info");
  db.prepare("INSERT INTO audits (id,project_id,start_url,status,max_pages,pages_crawled,started_at) VALUES (?,?,?,?,?,?,?)").run("audit-0", pid, "https://acme.com/", "failed", 50, 0, "2025-12-01T00:00:00.000Z");
  const d = await dash();
  assert.equal(d.audit.id, id, "the newest audit wins");
  assert.deepEqual(d.audit.bySeverity, { critical: 2, warning: 1, info: 1 });
  assert.deepEqual(d.audit.topIssues.map((i: any) => [i.type, i.severity, i.pages]), [["missing_title", "critical", 2], ["thin_content", "warning", 1], ["no_canonical", "info", 1]]);
  assert.equal(d.steps.find((s: any) => s.key === "audit").done, true);
  assert.equal(d.steps.find((s: any) => s.key === "gsc").done, false);
  db.prepare("INSERT INTO google_grants (id,provider,account_id,email,access_token_enc,expires_at,created_at,updated_at) VALUES ('g','gsc','acct','a@b.c','x',0,'2026-01-01','2026-01-01')").run();
  db.prepare("INSERT INTO gsc_connections (project_id,site_url,grant_id,connected_email,created_at) VALUES (?,?,?,?,?)").run(pid, "sc-domain:acme.com", "g", "a@b.c", "2026-01-01");
  const d2 = await dash();
  assert.equal(d2.steps.find((s: any) => s.key === "gsc").done, true);
  assert.deepEqual(d2.gsc, { siteUrl: "sc-domain:acme.com" });
  assert.equal(d2.ga4, null);
});

test("dashboard steps can be dismissed and restored; done steps cannot be hidden; unknown steps are rejected", async () => {
  const post = (step: string, method = "POST") => c.app.request(`/api/projects/${pid}/dashboard/steps/${step}/dismiss`, { method });
  assert.equal((await post("gsc")).status, 204);
  assert.equal((await post("gsc")).status, 204, "dismissing twice is harmless");
  let d = await dash();
  assert.equal(d.steps.find((s: any) => s.key === "gsc").dismissed, true);
  assert.equal(d.openSteps, 7, "9 steps, 'domain' done, 'gsc' dismissed");
  assert.equal((await post("gsc", "DELETE")).status, 204);
  d = await dash();
  assert.equal(d.steps.find((s: any) => s.key === "gsc").dismissed, false);
  await post("domain");
  d = await dash();
  assert.equal(d.steps.find((s: any) => s.key === "domain").dismissed, false, "a completed step is never shown as dismissed");
  assert.equal((await post("nonsense")).status, 400);
  assert.equal((await c.app.request("/api/projects/nope/dashboard/steps/gsc/dismiss", { method: "POST" })).status, 404);
});
