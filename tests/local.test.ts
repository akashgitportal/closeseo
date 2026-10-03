import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeDfs, type FakeDfs } from "./support/fake-dataforseo.ts";
import { makeClient, makeCtx } from "./support/harness.ts";

let dfs: FakeDfs, c: ReturnType<typeof makeClient>, pid: string;
before(async () => { dfs = await startFakeDfs(); });
after(() => dfs.close());
const control = (b: object) => fetch(`${dfs.url}/__control`, { method: "POST", body: JSON.stringify(b) });
beforeEach(async () => {
  dfs.reset(); await control({ taskMode: "ok", taskReadyMs: 0 });
  c = makeClient(makeCtx({ dfsUrl: dfs.url, BUSINESS_POLL_MS: "20", DFS_RETRY_DELAY_MS: "5" }));
  pid = (await c.tool("create_project", { name: "Local", domain: "joespizza.example" })).structuredContent.project.id;
});
const calls = (p: string) => dfs.stats().byPath[p] ?? 0;
const bodies = (p: string) => dfs.stats().bodies[p] as any[];
const near = { latitude: 40.7128, longitude: -74.006 };

test("all 58 tools now answer, none says 'not available'", async () => {
  const names = ["search_local_businesses", "get_local_serp_results", "get_google_business_questions", "get_business_profile", "get_business_reviews", "get_business_updates", "list_business_categories", "get_local_rank_grid"];
  for (const n of names) assert.doesNotMatch((await c.tool(n, { projectId: pid }, { skipSchema: true })).content[0]!.text, /not available in this release/);
});

test("business profile: location handling, text summary and the not-found hint", async () => {
  const r = await c.tool("get_business_profile", { projectId: pid, businessName: "Joe's Pizza" });
  assert.equal(r.structuredContent.profile.cid, "111");
  assert.match(r.content[0]!.text, /^Google Business Profile found:\ntitle: Joe's Pizza\ncategory: pizza_restaurant \(\+ restaurant\)\nrating: 4.60 from 820 reviews\nrating breakdown: 5★ 70, 4★ 20, 3★ 5, 2★ 2, 1★ 3/);
  assert.match(r.content[0]!.text, /hours: mon 09:00-17:30 \| tue 09:00-12:00,13:00-17:00 \| wed closed \| thu closed \| fri 09:00-17:00 \| sat closed \| sun closed/);
  assert.match(r.content[0]!.text, /check_url: https:\/\/google\.com\/search\?q=111/);
  const sent = bodies("/v3/business_data/google/my_business_info/live")[0];
  assert.deepEqual(sent, { keyword: "Joe's Pizza", location_code: 2840, language_code: "en" });
  await c.tool("get_business_profile", { projectId: pid, cid: "222", near: { ...near, radiusKm: 0.2 } });
  assert.deepEqual(bodies("/v3/business_data/google/my_business_info/live")[1], { keyword: "cid:222", location_coordinate: "40.7128,-74.006,200", language_code: "en" });
  const miss = await c.tool("get_business_profile", { projectId: pid, businessName: "Nobody Here" });
  assert.equal(miss.structuredContent.profile, null);
  assert.match(miss.content[0]!.text, /Google has no business profile for that identifier/);
});

test("listings: radius in whole km, filters and sort order forwarded, empty result is not an error", async () => {
  const r = await c.tool("search_local_businesses", { projectId: pid, near: { ...near, radiusKm: 4.6 }, minRating: 4, minReviews: 50, isClaimed: false, sortBy: "reviews", categories: ["pizza_restaurant"] });
  const sent = bodies("/v3/business_data/business_listings/search/live")[0];
  assert.equal(sent.location_coordinate, "40.7128,-74.006,5");
  assert.deepEqual(sent.filters, [["rating.value", ">=", 4], "and", ["rating.votes_count", ">=", 50]]);
  assert.deepEqual([sent.order_by, sent.is_claimed, sent.limit], [["rating.votes_count,desc"], false, 20]);
  assert.deepEqual(r.structuredContent.businesses.map((b: any) => b.title), ["Slice Heaven"]);
  assert.ok(!("ignored_provider_field" in r.structuredContent.businesses[0]), "only the documented fields are kept");
  assert.match(r.content[0]!.text, /^1 local business found\.\ntitle \| category \| rating \| reviews \| phone \| address\nSlice Heaven \| pizza_restaurant \| 4.10 \| 95 \| \+1 555 0102 \| 222 Main St$/);
  const none = await c.tool("search_local_businesses", { projectId: pid, near: { ...near, radiusKm: 5 }, query: "nothing-here" });
  assert.deepEqual([none.isError, none.structuredContent.businesses], [undefined, []]);
  assert.equal((await c.tool("search_local_businesses", { projectId: pid, near: { ...near, radiusKm: 5 }, query: "bad-coordinate" })).isError, true, "a real provider error is still an error");
});

test("reviews: queued task is collected in one call, resumable when it is still running, and billed once", async () => {
  const done = await c.tool("get_business_reviews", { projectId: pid, businessName: "Joe's Pizza", depth: 10 });
  assert.equal(done.structuredContent.status, "completed");
  assert.match(done.structuredContent.taskId, /^google:bd-/);
  assert.equal(done.structuredContent.reviews.length, 10);
  assert.equal(done.structuredContent.totals.reviews_count, 820);
  assert.ok(!("extra_noise" in done.structuredContent.reviews[0]));
  const posted = bodies("/v3/business_data/google/reviews/task_post")[0];
  assert.deepEqual([posted.keyword, posted.sort_by, posted.priority, posted.depth], ["Joe's Pizza", "newest", 2, 10]);
  assert.match(done.content[0]!.text, /^Got 10 reviews \(the profile has 820 in total\)\. The table shortens long reviews/);
  assert.match(done.content[0]!.text, /…\s*\| yes|…\s*\| no/, "long review text is cut at 120 characters");
  const ext = await c.tool("get_business_reviews", { projectId: pid, cid: "111", includeOtherSources: true });
  assert.match(ext.structuredContent.taskId, /^extended:/);
  assert.equal(bodies("/v3/business_data/google/extended_reviews/task_post")[0].sort_by, undefined, "the extended endpoint has no sort option");
  assert.deepEqual(ext.structuredContent.reviews.map((r: any) => r.source.title).slice(0, 2), ["Tripadvisor", "Yelp"]);

  await control({ taskMode: "never_ready" });
  const slow = await c.tool("get_business_reviews", { projectId: pid, businessName: "Joe's Pizza" });
  assert.equal(slow.structuredContent.status, "processing");
  assert.equal(calls("/v3/business_data/google/reviews/task_get/" + encodeURIComponent(slow.structuredContent.taskId.split(":")[1])), 6, "six checks, then it hands back the task id");
  assert.match(slow.content[0]!.text, /Call get_business_reviews again with taskId "google:bd-.*" in a minute or so/);
  await control({ taskMode: "ok" });
  const resumed = await c.tool("get_business_reviews", { projectId: pid, taskId: slow.structuredContent.taskId });
  assert.equal(resumed.structuredContent.status, "completed");
  assert.equal(calls("/v3/business_data/google/reviews/task_post"), 2, "resuming does not post a new task");
  const usage = (await (await c.get("/api/usage")).json()) as any;
  assert.equal(usage.byFeature.find((f: any) => f.feature === "local").calls, 3, "three posted tasks were billed once each (not again when collected)");
  const none = await c.tool("get_business_reviews", { projectId: pid, businessName: "Nobody Here" });
  assert.match(none.content[0]!.text, /Nothing matched the request/);
});

test("posts: bare task ids only, empty profile is reported plainly", async () => {
  const r = await c.tool("get_business_updates", { projectId: pid, businessName: "Joe's Pizza" });
  assert.equal(r.structuredContent.updates.length, 3);
  assert.match(r.content[0]!.text, /^Got 3 Google Business posts\.\n#.*posted.*post.*url/);
  assert.match((await c.tool("get_business_updates", { projectId: pid, businessName: "Slice Heaven" })).content[0]!.text, /has not published any posts/);
  const bad = await c.tool("get_business_updates", { projectId: pid, taskId: "google:abc" });
  assert.match(bad.content[0]!.text, /belongs to get_business_reviews/);
});

test("task posting failures keep the provider's message; paused accounts say so", async () => {
  await control({ pausePaths: ["/v3/business_data/google/reviews/task_post"] });
  const r = await c.tool("get_business_reviews", { projectId: pid, businessName: "Joe's Pizza" });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /temporarily paused access/);
  assert.equal(calls("/v3/business_data/google/reviews/task_post"), 1, "a task post is not retried: it could be billed twice");
  await control({ pausePaths: [] });
});

test("categories: ranked list, filter, 7-day cache, and malformed provider rows are skipped", async () => {
  const all = await c.tool("list_business_categories", { projectId: pid, limit: 200 });
  assert.deepEqual(all.structuredContent.categories.map((x: any) => x.category), ["pizza_restaurant", "plumber", "pizza_delivery", "bakery"]);
  const q = await c.tool("list_business_categories", { projectId: pid, query: "PIZZA" });
  assert.match(q.content[0]!.text, /^2 categories contain "PIZZA"; 2 shown\.\ncategory \| businesses\npizza_restaurant \| 5000\npizza_delivery \| 400$/);
  assert.equal(calls("/v3/business_data/business_listings/categories"), 1, "second call served from cache");
  assert.equal(((await (await c.get("/api/usage")).json()) as any).totalUsd, 0, "the category list is free");
});

test("local rank grid: layout, summary, zoom, request fields and failures", async () => {
  const r = await c.tool("get_local_rank_grid", { projectId: pid, keyword: "pizza", target: { cid: "111" }, center: near });
  const g = r.structuredContent;
  assert.equal(g.grid.length, 9);
  assert.deepEqual([g.grid[0].row, g.grid[0].col, g.grid[4].row, g.grid[4].col], [0, 0, 1, 1]);
  assert.equal(g.matchedBusiness.title, "Joe's Pizza");
  assert.equal(g.summary.pointsSearched, 9);
  assert.match(r.content[0]!.text, /^Map rankings for "pizza" on a 3x3 grid, points 2 km apart, zoom 13, looking at the top 20 results\./);
  assert.equal(calls("/v3/serp/google/maps/live/advanced"), 9);
  const sent = bodies("/v3/serp/google/maps/live/advanced")[0];
  assert.deepEqual([sent.device, sent.os, sent.depth, sent.search_places, sent.language_code], ["mobile", "android", 20, false, "en"]);
  assert.match(sent.location_coordinate, /^40\.\d+,-74\.\d+,13z$/);
  const centre = bodies("/v3/serp/google/maps/live/advanced").find((b) => b.location_coordinate.startsWith("40.7128,-74.006,"));
  assert.ok(centre, "the middle point is the requested centre");
  const lines = r.content[0]!.text.split("\n").slice(2, 5);
  assert.ok(lines.every((l: string) => /^( ?[\d–x]) ( ?[\d–x]) ( ?[\d–x])$/.test(l)), lines.join("|"));
  const usage = (await (await c.get(`/api/usage?projectId=${pid}`)).json()) as any;
  assert.deepEqual(usage.byFeature.map((f: any) => f.feature), ["local"], "maps searches count as local, not generic SERP spend");

  const partial = await c.tool("get_local_rank_grid", { projectId: pid, keyword: "pizza", target: { name: "nobody" }, center: near });
  assert.equal(partial.structuredContent.matchedBusiness, null);
  assert.equal(partial.structuredContent.summary.averageRank, null);
  const allFail = await c.tool("get_local_rank_grid", { projectId: pid, keyword: "pizza [serpfail]", target: { cid: "111" }, center: near }, { skipSchema: true });
  assert.equal(allFail.isError, true);
});

test("a monthly budget stops a rank grid before it spends more, and an unauthorised key stops it at once", async () => {
  c.ctx.db.prepare("INSERT INTO budgets (scope,project_id,monthly_limit_usd,updated_at) VALUES ('global',NULL,0.0001,'x')").run();
  c.ctx.db.prepare("INSERT INTO usage_events (id,provider,feature,cost_usd,created_at) VALUES ('a','dataforseo','serp',1,?)").run(new Date().toISOString());
  const r = await c.tool("get_local_rank_grid", { projectId: pid, keyword: "pizza", target: { cid: "111" }, center: near }, { skipSchema: true });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /monthly budget/);
  assert.equal(calls("/v3/serp/google/maps/live/advanced"), 0);
  const bad = makeClient(makeCtx({ dfsUrl: dfs.url, noKey: true }));
  const p2 = (await bad.tool("create_project", { name: "N" })).structuredContent.project.id;
  assert.match((await bad.tool("get_local_rank_grid", { projectId: p2, keyword: "k", target: { cid: "1" }, center: near }, { skipSchema: true })).content[0]!.text, /DATAFORSEO_API_KEY/);
});
