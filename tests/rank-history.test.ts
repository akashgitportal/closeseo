import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeDfs, type FakeDfs } from "./support/fake-dataforseo.ts";
import { makeClient, makeCtx } from "./support/harness.ts";
import { awaitRankRuns } from "../src/services/rankTracking.ts";

let dfs: FakeDfs, c: ReturnType<typeof makeClient>, pid: string, tid: string;
before(async () => { dfs = await startFakeDfs(); });
after(() => dfs.close());
const patch = (body: unknown, id = tid) => c.app.request(`/api/projects/${pid}/rank-trackers/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;
const base = () => `/api/projects/${pid}/rank-trackers/${tid}`;
const run = async () => { await c.tool("run_rank_tracker", { projectId: pid, trackerId: tid, maxCostCredits: 100000 }); await awaitRankRuns(); };
beforeEach(async () => {
  dfs.reset();
  c = makeClient(makeCtx({ dfsUrl: dfs.url, RANK_POLL_MS: "25" }));
  pid = (await c.tool("create_project", { name: "Hist", domain: "example.com" })).structuredContent.project.id;
  tid = (await c.tool("create_rank_tracker", { projectId: pid, devices: "both" })).structuredContent.config.id;
  await c.tool("add_rank_tracking_keywords", { projectId: pid, trackerId: tid, keywords: ["alpha", "beta", "unranked thing"] });
});

test("edit: devices, depth and schedule change; the schedule anchor only moves when the schedule changed", async () => {
  const a = await json(patch({ devices: "desktop", serpDepth: 20 }));
  assert.deepEqual([a.config.devices, a.config.serpDepth, a.config.scheduleInterval, a.config.nextCheckAt], ["desktop", 20, "manual", null]);
  const w = await json(patch({ scheduleInterval: "weekly", scheduleTime: { weekday: 2, hour: 9, minute: 0, timeZone: "UTC" } }));
  assert.equal(w.config.scheduleInterval, "weekly");
  const anchor = w.config.nextCheckAt;
  assert.ok(anchor);
  const again = await json(patch({ scheduleInterval: "weekly", devices: "both" }));
  assert.equal(again.config.nextCheckAt, anchor, "resending the same interval does not re-randomise the run time");
  const off = await json(patch({ scheduleInterval: "manual" }));
  assert.equal(off.config.nextCheckAt, null);
  assert.equal((await patch({ scheduleTime: { hour: 1, minute: 0 } })).status, 400, "a time needs a schedule");
  assert.equal((await patch({ scheduleInterval: "weekly", scheduleTime: { hour: 1, minute: 0 } })).status, 400, "weekly needs a weekday");
});

test("edit validation and the duplicate guard", async () => {
  for (const [body, re] of [[{ devices: "tablet" }, /devices/], [{ serpDepth: 15 }, /10, 20/], [{ serpDepth: 110 }, /10, 20/], [{ scheduleInterval: "hourly" }, /scheduleInterval/], [{ isActive: "no" }, /isActive/], [{ locationCode: -1 }, /locationCode/], [{ domain: "" }, /not a usable domain/], [{ scheduleInterval: "daily", scheduleTime: { hour: 1, minute: 0, timeZone: "Mars/Base" } }, /time zone/]] as [object, RegExp][]) {
    const r = await patch(body); assert.equal(r.status, 400, JSON.stringify(body)); assert.match((await r.json() as any).error.message, re);
  }
  assert.equal((await patch({ devices: "mobile" }, "nope")).status, 404);
  const other = (await c.tool("create_rank_tracker", { projectId: pid, domain: "other.com" })).structuredContent.config.id;
  const dup = await patch({ domain: "example.com" }, other);
  assert.equal(dup.status, 400);
  assert.match((await dup.json() as any).error.message, /already tracked/);
  assert.equal((await patch({ domain: "WWW.Other2.com/x" }, other)).status, 200);
});

test("archive hides a tracker from the list but keeps its data; restoring brings it back", async () => {
  await run();
  const arch = await json(patch({ isActive: false }));
  assert.equal(arch.config.isActive, false);
  const list = (await c.tool("get_rank_tracker", { projectId: pid })).structuredContent.configs;
  assert.deepEqual(list, []);
  const still = (await c.tool("get_rank_tracker", { projectId: pid, trackerId: tid })).structuredContent;
  assert.equal(still.results.rows.length, 3, "history is kept");
  await patch({ isActive: true });
  assert.equal((await c.tool("get_rank_tracker", { projectId: pid })).structuredContent.configs.length, 1);
  // a new tracker for the same domain and market may be created while the old one is archived, but not restored on top of it
  await patch({ isActive: false });
  await c.tool("create_rank_tracker", { projectId: pid, devices: "both" });
  const clash = await patch({ isActive: true });
  assert.equal(clash.status, 400);
});

test("keyword history, trend buckets and position matrix come from completed runs only", async () => {
  const kws = (await c.tool("get_rank_tracker", { projectId: pid, trackerId: tid })).structuredContent.results.rows;
  const alpha = kws.find((k: any) => k.keyword === "alpha").trackingKeywordId;
  assert.deepEqual((await json(c.get(`${base()}/keywords/${alpha}/history`))).history, [], "no runs yet");
  await run(); await new Promise((r) => setTimeout(r, 1100)); await run();
  const hist = (await json(c.get(`${base()}/keywords/${alpha}/history`))).history;
  assert.equal(hist.length, 4, "two runs x two devices");
  assert.deepEqual([...new Set(hist.map((h: any) => h.device))].sort(), ["desktop", "mobile"]);
  assert.ok(hist.every((h: any, i: number) => i === 0 || hist[i - 1].checkedAt <= h.checkedAt), "oldest first");
  assert.equal((await json(c.get(`${base()}/keywords/${alpha}/history?sinceDays=1`))).history.length, 4);
  c.ctx.db.prepare("UPDATE rank_snapshots SET checked_at='2001-01-01 00:00:00'").run();
  assert.equal((await json(c.get(`${base()}/keywords/${alpha}/history`))).history.length, 0, "older than a year is cut");
  assert.equal((await json(c.get(`${base()}/keywords/${alpha}/history?sinceDays=730`))).history.length, 0);
  c.ctx.db.prepare("UPDATE rank_snapshots SET checked_at=?").run(new Date().toISOString().slice(0, 19).replace("T", " "));

  const trend = (await json(c.get(`${base()}/trend?device=mobile`))).trend;
  assert.equal(trend.length, 2);
  for (const t of trend) assert.equal(t.top3 + t.top4to10 + t.top11to20 + t.notRanking, 3, "every keyword is in exactly one bucket");
  assert.ok(trend[0].notRanking >= 1, "the unranked keyword counts as not ranking");
  const matrix = (await json(c.get(`${base()}/matrix?device=desktop&runLimit=1`))).matrix;
  assert.equal(matrix.length, 3, "one run, three keywords");
  assert.equal(new Set(matrix.map((m: any) => m.runId)).size, 1);
  assert.equal((await json(c.get(`${base()}/matrix?device=desktop`))).matrix.length, 6);
});

test("history endpoints validate their inputs and scope to the project", async () => {
  for (const q of ["/trend", "/trend?device=tablet", "/trend?device=mobile&sinceDays=0", "/trend?device=mobile&sinceDays=731", "/trend?device=mobile&sinceDays=x", "/matrix", "/matrix?device=mobile&runLimit=27", "/matrix?device=mobile&runLimit=0"]) {
    assert.equal((await c.get(`${base()}${q}`)).status, 400, q);
  }
  assert.equal((await c.get(`/api/projects/${pid}/rank-trackers/nope/trend?device=mobile`)).status, 404);
  const otherProject = (await c.tool("create_project", { name: "Other", domain: "other.com" })).structuredContent.project.id;
  assert.equal((await c.get(`/api/projects/${otherProject}/rank-trackers/${tid}/trend?device=mobile`)).status, 404, "another project cannot read this tracker");
});
