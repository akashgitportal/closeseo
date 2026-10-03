import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeDfs, type FakeDfs } from "./support/fake-dataforseo.ts";
import { makeClient, makeCtx } from "./support/harness.ts";
import { awaitRankRuns, failInterruptedRuns, runDueTrackers } from "../src/services/rankTracking.ts";

let dfs: FakeDfs;
let c: ReturnType<typeof makeClient>;
let pid: string;
const control = (b: object) => fetch(`${dfs.url}/__control`, { method: "POST", body: JSON.stringify(b) });
before(async () => { dfs = await startFakeDfs(); });
after(() => dfs.close());
beforeEach(async () => {
  dfs.reset(); await control({ taskMode: "ok", taskReadyMs: 20 });
  c = makeClient(makeCtx({ dfsUrl: dfs.url, RANK_POLL_MS: "25", RANK_QUEUE_TIMEOUT_MS: "400" }));
  pid = (await c.tool("create_project", { name: "Rank", domain: "example.com" })).structuredContent.project.id;
});

async function tracker(args: Record<string, unknown> = {}) { return (await c.tool("create_rank_tracker", { projectId: pid, ...args })).structuredContent; }
const add = (trackerId: string, keywords: string[], extra: Record<string, unknown> = {}) => c.tool("add_rank_tracking_keywords", { projectId: pid, trackerId, keywords, ...extra });
const run = async (trackerId: string, maxCostCredits = 100000) => { const r = await c.tool("run_rank_tracker", { projectId: pid, trackerId, maxCostCredits }); await awaitRankRuns(); return r; };
const get = async (trackerId: string) => (await c.tool("get_rank_tracker", { projectId: pid, trackerId })).structuredContent;

test("create: tool defaults (mobile, depth 40, manual), config shape, validation", async () => {
  const t = await tracker();
  assert.deepEqual(Object.keys(t.config), ["id", "projectId", "domain", "locationCode", "languageCode", "locationName", "devices", "serpDepth", "scheduleInterval", "nextCheckAt", "isActive", "lastCheckedAt", "lastSkipReason", "createdAt"]);
  assert.deepEqual([t.config.domain, t.config.devices, t.config.serpDepth, t.config.scheduleInterval, t.config.locationCode, t.config.nextCheckAt, t.config.isActive], ["example.com", "mobile", 40, "manual", 2840, null, true]);
  assert.match(t.config.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal((await c.tool("create_rank_tracker", { projectId: pid })).content[0]!.text, "That domain is already tracked for this country");
  assert.equal((await tracker({ domain: "HTTPS://WWW.Other.com/x" })).config.domain, "other.com");
  const noDomain = (await c.tool("create_project", { name: "ND" })).structuredContent.project.id;
  assert.equal((await c.tool("create_rank_tracker", { projectId: noDomain })).content[0]!.text, "Give a domain, or set a domain on the project first");
  const sched = await tracker({ domain: "s.com", scheduleInterval: "daily" });
  assert.ok(new Date(sched.config.nextCheckAt) > new Date()); const h = new Date(sched.config.nextCheckAt).getUTCHours(); assert.ok(h >= 4 && h <= 9, "random 04-09 UTC slot");
  assert.equal((await c.tool("create_rank_tracker", { projectId: pid, domain: "w.com", scheduleInterval: "weekly", scheduleTime: { hour: 1, minute: 0 } })).content[0]!.text, "Weekly checks need a weekday for the run time");
  assert.equal((await c.tool("create_rank_tracker", { projectId: pid, domain: "m.com", scheduleTime: { hour: 1, minute: 0 } })).content[0]!.text, "A run time only applies to daily, weekly or monthly schedules");
  const berlin = await tracker({ domain: "b.com", scheduleInterval: "daily", scheduleTime: { hour: 7, minute: 15, timeZone: "Europe/Berlin" } });
  assert.match(berlin.config.nextCheckAt, /T0[56]:15:00\.000Z$/);
  assert.equal((await c.tool("create_rank_tracker", { projectId: pid, domain: "l.com", locationName: "Atlantis" })).isError, true);
  const local = await tracker({ domain: "l.com", locationName: "New York,New York,United States" });
  assert.equal(local.config.locationName, "New York,New York,United States");
  assert.equal((await c.tool("create_rank_tracker", { projectId: pid, domain: "l.com", locationName: "New York,New York,United States" })).content[0]!.text, "That domain is already tracked for this city");
  assert.deepEqual((await c.tool("get_rank_tracker", { projectId: pid })).structuredContent.configs.length, 5);
});

test("keywords: lower-cased by default, matchCase keeps case, dedupe, counts, remove by id", async () => {
  const t = await tracker();
  const a = (await add(t.trackerId, ["Alpha", "alpha", " beta "])).structuredContent;
  assert.deepEqual([a.requested, a.added], [3, 2]);
  assert.equal((await add(t.trackerId, ["ALPHA"])).structuredContent.added, 0);
  const mc = (await add(t.trackerId, ["Nodex", "nodex"], { matchCase: true })).structuredContent;
  assert.equal(mc.added, 2, "match-case keeps 'Nodex' and 'nodex' as two keywords");
  assert.ok((await add(t.trackerId, [""])).isError);
  const rm = (await c.tool("remove_rank_tracking_keywords", { projectId: pid, trackerId: t.trackerId, keywordIds: [a.addedIds[0], a.addedIds[0], "00000000-0000-0000-0000-000000000000"] })).structuredContent;
  assert.deepEqual([rm.requested, rm.removed], [3, 1]);
  const got = await get(t.trackerId);
  assert.deepEqual(got.results.rows.map((r: any) => r.keyword), ["beta", "Nodex", "nodex"]);
  assert.deepEqual(Object.keys(got.results.rows[0]), ["trackingKeywordId", "keyword", "matchCase", "searchVolume", "keywordDifficulty", "cpc", "desktop", "mobile"]);
  assert.equal((await add("00000000-0000-0000-0000-000000000000", ["x"])).content[0]!.text, "No such rank tracker in this project");
});

test("cost estimate uses live per-call pricing; CREDIT_MARKUP reproduces hosted numbers", async () => {
  const t = await tracker({ devices: "both", serpDepth: 20, scheduleInterval: "weekly" });
  await add(t.trackerId, ["a", "b"], { maxEstimatedScheduledCheckCredits: 100 });
  const e = (await c.tool("estimate_rank_tracker_cost", { projectId: pid, trackerId: t.trackerId, additionalKeywordCount: 2 })).structuredContent;
  assert.deepEqual([e.keywordCount, e.devicesCount, e.totalChecks, e.existingKeywordCount, e.additionalKeywordCount, e.method], [4, 2, 8, 2, 2, "live"]);
  assert.deepEqual([e.costUsd, e.costCredits], [0.028, 32]);
  assert.deepEqual([e.scheduledEstimate.costCredits, e.scheduledEstimate.checksPerMonth, e.scheduledEstimate.monthlyCostCredits], [9, 4, 36]);
  assert.equal((await c.tool("estimate_rank_tracker_cost", { projectId: pid, trackerId: t.trackerId, additionalKeywords: ["x", "site:y.com z"] })).structuredContent.costUsd, 0.056, "advanced-operator keywords bill 5x");
  const hosted = makeClient(makeCtx({ dfsUrl: dfs.url, CREDIT_MARKUP: "1.28" }));
  const p = (await hosted.tool("create_project", { name: "H", domain: "example.com" })).structuredContent.project.id;
  const tt = (await hosted.tool("create_rank_tracker", { projectId: p, devices: "both", serpDepth: 20, scheduleInterval: "weekly" })).structuredContent.trackerId;
  const he = (await hosted.tool("estimate_rank_tracker_cost", { projectId: p, trackerId: tt, additionalKeywordCount: 2 })).structuredContent;
  assert.deepEqual([he.costUsd, he.costCredits, he.scheduledEstimate.costUsd, he.scheduledEstimate.costCredits], [0.01792, 20, 0.00538, 6]);
});

test("scheduled trackers need an explicit per-check credit ceiling for every addition", async () => {
  const t = await tracker({ scheduleInterval: "daily" });
  const r = await add(t.trackerId, ["one", "two"]);
  assert.ok(r.isError); assert.match(r.content[0]!.text, /^With these keywords every daily check would cost about \d+ credits at queued prices \(around \$0\.\d{4} each, roughly \d+ credits a month\)\. Run estimate_rank_tracker_cost/);
  assert.equal((await get(t.trackerId)).config.lastCheckedAt, null);
  assert.equal((await get(t.trackerId)).results.rows.length, 0, "nothing added on refusal");
  assert.ok((await add(t.trackerId, ["one", "two"], { maxEstimatedScheduledCheckCredits: 1 })).isError, "ceiling below the estimate");
  const ok = (await add(t.trackerId, ["one", "two"], { maxEstimatedScheduledCheckCredits: 100 })).structuredContent;
  assert.equal(ok.added, 2); assert.equal(ok.scheduledEstimate.scheduleInterval, "daily");
  assert.equal((await add(t.trackerId, ["one"])).structuredContent.added, 0, "re-adding an existing keyword needs no approval");
  const manual = await tracker({ domain: "man.com" });
  assert.equal((await add(manual.trackerId, ["x"])).structuredContent.scheduledEstimate, undefined, "manual trackers never need a ceiling");
});

test("manual run is live: records both devices, previous position falls back to the first check, features recorded", async () => {
  const t = await tracker({ devices: "both", serpDepth: 20 });
  await add(t.trackerId, ["seo tools", "unranked thing"]);
  const started = (await run(t.trackerId)).structuredContent;
  assert.equal(started.started, true);
  const res = await get(t.trackerId);
  assert.equal(res.results.run.status, "completed"); assert.equal(res.results.run.errorMessage, null); assert.ok(res.results.run.lastCheckedAt);
  const ranked = res.results.rows.find((r: any) => r.keyword === "seo tools");
  assert.ok(ranked.desktop.position >= 1 && ranked.desktop.position <= 21);
  assert.match(ranked.desktop.rankingUrl, /^https:\/\/www\.example\.com\//);
  assert.notEqual(ranked.mobile.position, ranked.desktop.position);
  assert.equal(ranked.desktop.previousPosition, ranked.desktop.position, "first check is its own baseline");
  assert.deepEqual(ranked.desktop.serpFeatures, ["people_also_ask"]);
  const un = res.results.rows.find((r: any) => r.keyword === "unranked thing");
  assert.deepEqual([un.desktop.position, un.desktop.rankingUrl], [null, null]);
  assert.equal(dfs.stats().byPath["/v3/serp/google/organic/live/advanced"], 4);
  assert.equal(dfs.stats().byPath["/v3/serp/google/organic/task_post"], undefined, "manual checks are not queued");
  const single = await tracker({ domain: "mobile-only.com" });
  await add(single.trackerId, ["k"]);
  await run(single.trackerId);
  const row = (await get(single.trackerId)).results.rows[0];
  assert.equal(row.desktop.position, null); assert.deepEqual(row.desktop.serpFeatures, []);
});
test("a run sends the tracker's device, depth and location", async () => {
  const t = await tracker({ devices: "mobile", serpDepth: 30, locationCode: 2826 });
  await add(t.trackerId, ["k"]);
  await run(t.trackerId);
  const b = dfs.stats().bodies["/v3/serp/google/organic/live/advanced"]!.at(-1) as any;
  assert.deepEqual([b.device, b.depth, b.location_code, b.language_code], ["mobile", 30, 2826, "en"]);
});
test("run guards: empty tracker, over-budget, missing key, concurrent run", async () => {
  const t = await tracker({ devices: "both", serpDepth: 20 });
  assert.equal((await c.tool("run_rank_tracker", { projectId: pid, trackerId: t.trackerId, maxCostCredits: 1000 })).content[0]!.text, "This tracker has no keywords yet; add some before checking");
  await add(t.trackerId, ["a", "b"]);
  const over = await c.tool("run_rank_tracker", { projectId: pid, trackerId: t.trackerId, maxCostCredits: 10 });
  assert.equal(over.content[0]!.text, "This check would cost 16 credits, more than the 10 that was approved. Get a fresh figure from estimate_rank_tracker_cost and have the user confirm it before retrying");
  assert.equal(dfs.stats().total, 0, "nothing was bought");
  await control({ mode: "slow", ms: 300 });
  const first = (await c.tool("run_rank_tracker", { projectId: pid, trackerId: t.trackerId, maxCostCredits: 1000 })).structuredContent;
  const second = (await c.tool("run_rank_tracker", { projectId: pid, trackerId: t.trackerId, maxCostCredits: 1000 })).structuredContent;
  assert.deepEqual([first.started, second.started, second.blockingRunId], [true, false, first.runId]);
  await awaitRankRuns();
  const nokey = makeClient(makeCtx({ noKey: true }));
  const p2 = (await nokey.tool("create_project", { name: "NK", domain: "example.com" })).structuredContent.project.id;
  const t2 = (await nokey.tool("create_rank_tracker", { projectId: p2 })).structuredContent.trackerId;
  await nokey.tool("add_rank_tracking_keywords", { projectId: p2, trackerId: t2, keywords: ["a"] });
  const r = await nokey.tool("run_rank_tracker", { projectId: p2, trackerId: t2, maxCostCredits: 1000 });
  assert.ok(r.isError); assert.match(r.content[0]!.text, /DATAFORSEO_API_KEY/);
});

for (const [mode, expect] of [["http503", /HTTP 503/], ["balance", /Payment Required/], ["http401", /HTTP 401/]] as const) {
  test(`run: provider failure (${mode}) marks the run failed with a useful message, and the tracker recovers`, async () => {
    const t = await tracker();
    await add(t.trackerId, ["a", "b", "c"]);
    await control({ mode });
    await run(t.trackerId);
    const r = (await get(t.trackerId)).results.run;
    assert.equal(r.status, "failed"); assert.match(r.errorMessage, expect);
    await control({ mode: "ok" });
    await run(t.trackerId);
    assert.equal((await get(t.trackerId)).results.run.status, "completed");
  });
}

function dueTracker(interval = "daily") { return tracker({ scheduleInterval: interval }); }
test("scheduled run is queued: posts tasks, polls, records results, advances the anchor without drift", async () => {
  const t = await dueTracker();
  await add(t.trackerId, ["seo tools", "other"], { maxEstimatedScheduledCheckCredits: 100 });
  const anchor = (await get(t.trackerId)).config.nextCheckAt as string;
  assert.equal(runDueTrackers(c.ctx, new Date(Date.parse(anchor) - 1000)), 0, "not due yet");
  assert.equal(runDueTrackers(c.ctx, new Date(Date.parse(anchor) + 3600_000)), 1);
  await awaitRankRuns();
  const g = await get(t.trackerId);
  assert.equal(g.results.run.status, "completed");
  assert.equal(g.config.nextCheckAt, new Date(Date.parse(anchor) + 86_400_000).toISOString(), "one interval after the anchor, not after 'now'");
  assert.equal(dfs.stats().byPath["/v3/serp/google/organic/task_post"], 1, "one post for both checks");
  assert.ok(dfs.stats().byPath["/v3/serp/google/organic/task_get/advanced/" + "x"] === undefined);
  assert.equal(dfs.stats().byPath["/v3/serp/google/organic/live/advanced"], undefined, "no live fallback needed");
  assert.ok(g.results.rows.every((r: any) => r.mobile.position !== undefined));
  assert.equal(c.ctx.db.prepare("SELECT trigger FROM rank_runs WHERE tracker_id=?").get(t.trackerId)!.trigger, "scheduled");
  assert.equal(runDueTrackers(c.ctx, new Date(Date.parse(anchor) + 3600_000)), 0, "does not run twice for the same slot");
});
test("queued tasks that are rejected, fail, or never become ready fall back to live checks", async () => {
  for (const taskMode of ["reject_post", "fail_tasks", "never_ready"]) {
    dfs.reset(); await control({ taskMode });
    const t = await tracker({ domain: `${taskMode}.com`, scheduleInterval: "daily" });
    await add(t.trackerId, ["a", "b"], { maxEstimatedScheduledCheckCredits: 100 });
    const anchor = Date.parse((await get(t.trackerId)).config.nextCheckAt);
    runDueTrackers(c.ctx, new Date(anchor + 1000));
    await awaitRankRuns();
    assert.equal((await get(t.trackerId)).results.run.status, "completed", taskMode);
    assert.equal(dfs.stats().byPath["/v3/serp/google/organic/live/advanced"], 2, `${taskMode}: both checks fell back to live`);
  }
});
test("scheduler skips trackers without keywords and records why; manual trackers never run", async () => {
  const empty = await dueTracker(); const manual = await tracker({ domain: "man.com" });
  await add(manual.trackerId, ["a"]);
  const anchor = Date.parse((await get(empty.trackerId)).config.nextCheckAt);
  assert.equal(runDueTrackers(c.ctx, new Date(anchor + 1000)), 0);
  assert.equal((await get(empty.trackerId)).config.lastSkipReason, "no_keywords");
  assert.equal((c.ctx.db.prepare("SELECT COUNT(*) AS n FROM rank_runs WHERE tracker_id=?").get(manual.trackerId) as { n: number }).n, 0);
});
test("restart recovery: runs left active are failed, then can be re-run", async () => {
  const t = await tracker();
  await add(t.trackerId, ["a"]);
  c.ctx.db.prepare("INSERT INTO rank_runs (id,tracker_id,status,trigger,created_at) VALUES ('stuck',?,'running','manual',?)").run(t.trackerId, new Date().toISOString());
  assert.equal((await c.tool("run_rank_tracker", { projectId: pid, trackerId: t.trackerId, maxCostCredits: 1000 })).structuredContent.started, false);
  assert.equal(failInterruptedRuns(c.ctx), 1);
  assert.equal((await run(t.trackerId)).structuredContent.started, true);
  assert.equal((c.ctx.db.prepare("SELECT status FROM rank_runs WHERE id='stuck'").get() as { status: string }).status, "failed");
});
test("deleting a project cascades to its trackers, runs and snapshots", async () => {
  const t = await tracker();
  await add(t.trackerId, ["a"]);
  await run(t.trackerId);
  assert.equal((await c.app.request(`/api/projects/${pid}`, { method: "DELETE" })).status, 204);
  for (const table of ["rank_trackers", "rank_tracker_keywords", "rank_runs", "rank_snapshots"]) assert.equal((c.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
});
