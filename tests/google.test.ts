import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeGoogle, type FakeGoogle } from "./support/fake-google.ts";
import { makeClient, makeCtx } from "./support/harness.ts";
import { getAccessToken, GoogleTokenError } from "../src/google/oauth.ts";
import { shiftDate } from "../src/services/ga4.ts";

const CID = "test-client-id.apps.googleusercontent.com", CSEC = "test-client-secret", SECRET = "s".repeat(40), ORIGIN = "http://localhost:3001";
let g: FakeGoogle;
before(async () => { g = await startFakeGoogle({ clientId: CID, clientSecret: CSEC }); });
after(() => g.close());

let c: ReturnType<typeof makeClient>;
let pid: string;
const env = (extra: Record<string, string> = {}) => ({ GOOGLE_CLIENT_ID: CID, GOOGLE_CLIENT_SECRET: CSEC, CLOSESEO_SECRET: SECRET, GOOGLE_API_ORIGIN: g.origin, GOOGLE_TOKEN_URL: `${g.origin}/token`, GOOGLE_AUTH_URL: `${g.origin}/auth`, PUBLIC_URL: ORIGIN, ...extra });
beforeEach(async () => {
  g.reset(); await g.control({});
  c = makeClient(makeCtx(env()));
  pid = (await c.tool("create_project", { name: "G", domain: "example.com" })).structuredContent.project.id;
});

/** Drive the whole consent round trip the way a browser would. */
async function connect(provider: "gsc" | "ga4", opts: Parameters<FakeGoogle["consent"]>[1] = {}, project = pid) {
  const start = (await (await c.post(`/api/google/${provider}/start`, { projectId: project })).json()) as { url: string };
  const { location } = g.consent(start.url, opts);
  const cb = new URL(location);
  const res = await c.get(cb.pathname + cb.search);
  return { start, location, res, redirect: res.headers.get("location") ?? "" };
}
const status = async () => (await (await c.get(`/api/google/status?projectId=${pid}`)).json()) as any;
const grantId = async (p: "gsc" | "ga4") => (await status())[p].accounts[0].grantId as string;
async function useSite(site = "sc-domain:example.com") { await connect("gsc"); return c.post("/api/google/gsc/select", { projectId: pid, grantId: await grantId("gsc"), siteUrl: site }); }
async function useProperty(id = "properties/111") { await connect("ga4"); return c.post("/api/google/ga4/select", { projectId: pid, grantId: await grantId("ga4"), propertyId: id }); }

test("configuration: Google is off until client id, secret and a 32+ char app secret are all present", async () => {
  const bare = makeClient(makeCtx());
  const p = (await bare.tool("create_project", { name: "N" })).structuredContent.project.id;
  assert.equal(((await (await bare.get(`/api/google/status?projectId=${p}`)).json()) as any).configured, false);
  assert.equal((await bare.post("/api/google/gsc/start", { projectId: p })).status, 412);
  const r = await bare.tool("get_search_console_performance", { projectId: p });
  assert.equal(r.structuredContent.reason, "gsc_oauth_not_configured"); assert.match(r.content[0]!.text, /GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and CLOSESEO_SECRET/);
  assert.equal((await bare.tool("inspect_urls", { projectId: p, urls: ["https://example.com/"] })).structuredContent.reason, "gsc_oauth_not_configured");
  assert.throws(() => makeCtx(env({ CLOSESEO_SECRET: "short" })), /at least 32/);
  const noSecret = makeClient(makeCtx(env({ CLOSESEO_SECRET: "" })));
  assert.equal((await noSecret.post("/api/google/gsc/start", { projectId: p })).status, 412);
});

test("consent URL: client, redirect, scopes, offline access, forced consent, PKCE S256, bound single-use state", async () => {
  const { url } = (await (await c.post("/api/google/gsc/start", { projectId: pid })).json()) as { url: string };
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, `${g.origin}/auth`);
  assert.deepEqual([u.searchParams.get("client_id"), u.searchParams.get("redirect_uri"), u.searchParams.get("response_type"), u.searchParams.get("access_type"), u.searchParams.get("prompt"), u.searchParams.get("code_challenge_method")],
    [CID, `${ORIGIN}/api/gsc/oauth/callback`, "code", "offline", "select_account consent", "S256"]);
  assert.equal(u.searchParams.get("scope"), "openid email profile https://www.googleapis.com/auth/webmasters.readonly");
  assert.ok((u.searchParams.get("state") ?? "").length >= 40 && (u.searchParams.get("code_challenge") ?? "").length >= 40);
  const ga = new URL(((await (await c.post("/api/google/ga4/start", { projectId: pid })).json()) as any).url);
  assert.match(ga.searchParams.get("scope")!, /analytics\.readonly/); assert.equal(ga.searchParams.get("redirect_uri"), `${ORIGIN}/api/ga4/oauth/callback`);
  assert.notEqual(ga.searchParams.get("state"), u.searchParams.get("state"));
  assert.equal((await c.post("/api/google/gsc/start", { projectId: "00000000-0000-0000-0000-000000000000" })).status, 404);
  assert.equal((await c.post("/api/google/bogus/start", { projectId: pid })).status, 404);
  assert.equal((await c.post("/api/google/gsc/start", {})).status, 400);
});

test("callback: stores an encrypted grant, returns to the project's integrations page, and the state cannot be replayed", async () => {
  const { start, location, res, redirect } = await connect("gsc");
  assert.equal(res.status, 302); assert.equal(redirect, `/?google=connected&provider=gsc#/p/${pid}/integrations`);
  assert.equal(g.stats().tokenGrants[0], "authorization_code");
  const row = c.ctx.db.prepare("SELECT * FROM google_grants").get() as any;
  assert.equal(row.email, "owner@example.com"); assert.equal(row.provider, "gsc");
  for (const col of [row.access_token_enc, row.refresh_token_enc]) assert.match(col, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  const dump = JSON.stringify(c.ctx.db.prepare("SELECT * FROM google_grants").all());
  assert.ok(!dump.includes("at-") && !dump.includes("rt-sub"), "no plaintext tokens in the database");
  assert.equal(await getAccessToken(c.ctx, row.id), "at-" + dump.match(/x/)?.length ? await getAccessToken(c.ctx, row.id) : "", "round-trips");
  const replay = await c.get(new URL(location).pathname + new URL(location).search);
  assert.match(replay.headers.get("location")!, /google_error=.*invalid%2C\+already\+used%2C\+or\+expired|google_error=This\+sign-in/);
  assert.ok(start.url);
  const forged = await c.get("/api/gsc/oauth/callback?code=x&state=nope");
  assert.match(forged.headers.get("location")!, /google_error=/); assert.equal((c.ctx.db.prepare("SELECT COUNT(*) AS n FROM google_grants").get() as any).n, 1);
  assert.match((await c.get("/api/gsc/oauth/callback")).headers.get("location")!, /google_error=Missing/);
});

test("state is provider-bound and expires", async () => {
  const { url } = (await (await c.post("/api/google/gsc/start", { projectId: pid })).json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const wrong = await c.get(`/api/ga4/oauth/callback?code=whatever&state=${state}`);
  assert.match(wrong.headers.get("location")!, /google_error=/);
  const { url: u2 } = (await (await c.post("/api/google/gsc/start", { projectId: pid })).json()) as { url: string };
  c.ctx.db.prepare("UPDATE google_oauth_states SET expires_at=?").run(Date.now() - 1);
  const { location } = g.consent(u2);
  const r = await c.get(new URL(location).pathname + new URL(location).search);
  assert.match(r.headers.get("location")!, /google_error=/); assert.equal((c.ctx.db.prepare("SELECT COUNT(*) AS n FROM google_grants").get() as any).n, 0);
  await c.post("/api/google/gsc/start", { projectId: pid });
  assert.equal((c.ctx.db.prepare("SELECT COUNT(*) AS n FROM google_oauth_states").get() as any).n, 1, "expired states are swept on the next start");
});

test("user declines, omits the permission box, or Google rejects the exchange: no grant is stored and the user is told", async () => {
  const denied = await connect("gsc", { deny: true });
  assert.equal(denied.redirect, `/?google_error=access_denied&provider=gsc#/p/${pid}/integrations`);
  assert.equal((c.ctx.db.prepare("SELECT COUNT(*) AS n FROM google_oauth_states").get() as any).n, 0, "state dropped");
  const partial = await connect("gsc", { scopes: ["openid", "email", "profile"] });
  assert.match(decodeURIComponent(partial.redirect.replace(/\+/g, " ")), /access was not granted/);
  const { url } = (await (await c.post("/api/google/gsc/start", { projectId: pid })).json()) as { url: string };
  const { location } = g.consent(url);
  const tampered = new URL(location); tampered.searchParams.set("code", "forged");
  assert.match((await c.get(tampered.pathname + tampered.search)).headers.get("location")!, /Google\+refused|Google refused/);
  assert.equal((c.ctx.db.prepare("SELECT COUNT(*) AS n FROM google_grants").get() as any).n, 0);
});

test("a re-consent without a refresh token keeps the old one; a second Google account becomes a second grant", async () => {
  await connect("gsc");
  await connect("gsc", { refresh: false });
  const row = c.ctx.db.prepare("SELECT refresh_token_enc FROM google_grants").get() as any;
  assert.ok(row.refresh_token_enc, "refresh token preserved");
  await connect("gsc", { sub: "sub-2", email: "second@example.com" });
  assert.equal((c.ctx.db.prepare("SELECT COUNT(*) AS n FROM google_grants").get() as any).n, 2);
  assert.deepEqual((await status()).gsc.accounts.map((a: any) => a.email).sort(), ["owner@example.com", "second@example.com"]);
});

test("callbacks are reachable without the bearer token (Google cannot send one); everything else is not", async () => {
  const k = makeClient(makeCtx(env({ AUTH_MODE: "api_key", CLOSESEO_API_KEY: "key-123" })));
  const H = { authorization: "Bearer key-123" };
  const p = ((await (await k.post("/api/tools/create_project", { name: "A" }, H)).json()) as any).data.project.id;
  assert.equal((await k.post("/api/google/gsc/start", { projectId: p })).status, 401);
  assert.equal((await k.get(`/api/google/status?projectId=${p}`)).status, 401);
  const { url } = (await (await k.post("/api/google/gsc/start", { projectId: p }, H)).json()) as { url: string };
  const { location } = g.consent(url);
  const cb = await k.get(new URL(location).pathname + new URL(location).search);
  assert.equal(cb.status, 302); assert.match(cb.headers.get("location")!, /google=connected/);
});

test("tokens: expired access tokens are refreshed once (even under concurrency) and re-stored; revoked grants ask to reconnect", async () => {
  await connect("gsc");
  const id = (c.ctx.db.prepare("SELECT id FROM google_grants").get() as any).id;
  const before = (c.ctx.db.prepare("SELECT access_token_enc FROM google_grants").get() as any).access_token_enc;
  c.ctx.db.prepare("UPDATE google_grants SET expires_at=?").run(Date.now() + 1000); // inside the 5 s skew
  g.reset(); await g.control({});
  const tokens = await Promise.all(Array.from({ length: 8 }, () => getAccessToken(c.ctx, id)));
  assert.equal(new Set(tokens).size, 1); assert.deepEqual(g.stats().tokenGrants, ["refresh_token"], "one refresh for eight callers");
  assert.notEqual((c.ctx.db.prepare("SELECT access_token_enc FROM google_grants").get() as any).access_token_enc, before);
  assert.equal(await getAccessToken(c.ctx, id), tokens[0], "fresh token is reused");
  c.ctx.db.prepare("UPDATE google_grants SET expires_at=?").run(0);
  await g.control({ revokeRefresh: true });
  await assert.rejects(getAccessToken(c.ctx, id), (e: unknown) => e instanceof GoogleTokenError && /Reconnect/.test((e as Error).message));
  await assert.rejects(getAccessToken(c.ctx, "missing"), /no longer exists/);
  c.ctx.db.prepare("UPDATE google_grants SET refresh_token_enc=NULL").run();
  await assert.rejects(getAccessToken(c.ctx, id), /no refresh token/);
});
test("tokens stored under another secret cannot be read", async () => {
  await connect("gsc");
  const id = (c.ctx.db.prepare("SELECT id FROM google_grants").get() as any).id;
  const other = { ...c.ctx, config: { ...c.ctx.config, appSecret: "z".repeat(40) } };
  await assert.rejects(getAccessToken(other, id), /cannot be decrypted/);
});

test("Search Console: choose a verified property; unverified, foreign or unknown ones are refused; disconnect works", async () => {
  await connect("gsc");
  const gid = await grantId("gsc");
  const st = await status();
  assert.deepEqual(st.gsc.accounts[0].sites.map((s: any) => s.siteUrl), ["sc-domain:example.com", "https://blog.example.com/", "https://unverified.example.org/"]);
  const sel = (siteUrl: string, grant = gid) => c.post("/api/google/gsc/select", { projectId: pid, grantId: grant, siteUrl });
  assert.equal((await sel("https://unverified.example.org/")).status, 400);
  assert.equal((await sel("https://other.example.net/")).status, 404);
  assert.equal((await sel("sc-domain:example.com", "nope")).status, 404);
  assert.equal((await sel("https://blog.example.com/")).status, 200);
  assert.equal((await sel("sc-domain:example.com")).status, 200, "re-selecting replaces the connection");
  assert.equal((await status()).gsc.connection.siteUrl, "sc-domain:example.com");
  assert.equal((await c.app.request(`/api/google/gsc/${pid}`, { method: "DELETE" })).status, 204);
  assert.equal((await status()).gsc.connection, null);
  const r = await c.tool("get_search_console_performance", { projectId: pid });
  assert.deepEqual([r.structuredContent.ok, r.structuredContent.reason], [false, "not_connected"]); assert.match(r.content[0]!.text, /not connected for this project\. Connect it here: http/);
});
test("list failures are reported per account instead of failing the page", async () => {
  await connect("gsc");
  await g.control({ gscMode: "forbidden" });
  assert.deepEqual([(await status()).gsc.accounts[0].requiresReconnect, (await status()).gsc.accounts[0].propertiesUnavailable], [true, false]);
});

test("get_search_console_performance: request body, defaults, clamps, filters wrapped in dimensionFilterGroups, output rounding", async () => {
  await useSite();
  const r = (await c.tool("get_search_console_performance", { projectId: pid, filters: [{ dimension: "page", expression: "/blog/" }], rowLimit: 1000, dimensions: ["query", "page"], startRow: 10 })).structuredContent;
  const b = g.stats().bodies["/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"]!.at(-1);
  assert.deepEqual([b.dimensions, b.rowLimit, b.startRow, b.type, b.dataState], [["query", "page"], 1000, 10, "web", "all"]);
  assert.deepEqual(b.dimensionFilterGroups, [{ groupType: "and", filters: [{ dimension: "page", operator: "equals", expression: "/blog/" }] }]);
  assert.ok(!("filters" in b), "a top-level filters field would be silently ignored by Google");
  assert.ok((await c.tool("get_search_console_performance", { projectId: pid, rowLimit: 1001 })).isError, "schema caps rowLimit at 1000");
  const days = (new Date(b.endDate).getTime() - new Date(b.startDate).getTime()) / 86_400_000;
  assert.equal(days, 28); assert.equal(new Date(b.endDate).getTime() <= Date.now() - 2.9 * 86_400_000, true, "ends ~3 days back for data lag");
  assert.deepEqual([r.ok, r.siteUrl, r.rowCount, r.dimensions], [true, "sc-domain:example.com", 30, ["query", "page"]]);
  assert.equal(r.rows[0].position, 11.1, "starts at row 10; position rounded to one decimal"); assert.equal(typeof r.rows[0].ctr, "number"); assert.ok(String(r.rows[0].ctr).length <= 8, "ctr rounded to 4 decimals");
  assert.deepEqual([r.hasMore, r.nextStartRow], [false, undefined]);
});
test("get_search_console_performance: date handling, limits and pagination", async () => {
  await useSite();
  const body = () => g.stats().bodies["/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"]!.at(-1);
  await c.tool("get_search_console_performance", { projectId: pid, dateRange: "last_7_days" });
  assert.equal((Date.parse(body().endDate) - Date.parse(body().startDate)) / 86_400_000, 7);
  await c.tool("get_search_console_performance", { projectId: pid, startDate: "2001-01-01", endDate: "2026-09-01" });
  const floor = new Date(); floor.setUTCMonth(floor.getUTCMonth() - 16);
  assert.ok(Math.abs(Date.parse(body().startDate) - floor.getTime()) < 3 * 86_400_000, "start is clamped to Search Console's 16-month history");
  const half = await c.tool("get_search_console_performance", { projectId: pid, startDate: "2026-09-01" });
  assert.deepEqual([half.structuredContent.ok, half.structuredContent.reason], [false, "invalid_request"]);
  assert.equal((await c.tool("get_search_console_performance", { projectId: pid, dimensions: ["searchAppearance", "query"] })).content[0]!.text, "searchAppearance must be the only dimension when used.");
  const page1 = (await c.tool("get_search_console_performance", { projectId: pid, rowLimit: 10 })).structuredContent;
  assert.deepEqual([page1.rowCount, page1.hasMore, page1.nextStartRow], [10, true, 10]);
  const exact = (await c.tool("get_search_console_performance", { projectId: pid, rowLimit: 10, startRow: 30 })).structuredContent;
  assert.deepEqual([exact.rowCount, exact.hasMore], [10, true], "a full page may have more rows behind it");
  const last = (await c.tool("get_search_console_performance", { projectId: pid, rowLimit: 10, startRow: 35 })).structuredContent;
  assert.deepEqual([last.rowCount, last.hasMore], [5, false]);
  await g.control({ gscRows: 0 });
  const empty = await c.tool("get_search_console_performance", { projectId: pid });
  assert.equal(empty.structuredContent.rowCount, 0); assert.match(empty.content[0]!.text, /No rows for this query\/date range/);
});
test("get_search_console_performance: position/impression filters are applied after fetching the whole window, with Google-space pagination", async () => {
  await useSite();
  const r = (await c.tool("get_search_console_performance", { projectId: pid, minPosition: 4, maxPosition: 10, minImpressions: 1000, rowLimit: 3 })).structuredContent;
  const b = g.stats().bodies["/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"]!.at(-1);
  assert.equal(b.rowLimit, 1000, "metric filters fetch the maximum window");
  assert.ok(r.rows.every((x: any) => x.position >= 4 && x.position <= 10 && x.impressions >= 1000));
  assert.equal(r.rowCount, 3); assert.equal(r.hasMore, true);
  const next = (await c.tool("get_search_console_performance", { projectId: pid, minPosition: 4, maxPosition: 10, rowLimit: 3, startRow: r.nextStartRow })).structuredContent;
  assert.ok(next.rows[0].keys[0] !== r.rows[0].keys[0], "next page continues after the last returned row");
});
test("Search Console errors become actionable, structured results (never exceptions)", async () => {
  await useSite();
  for (const [mode, re, reason] of [["forbidden", /denied access to this property/, "api_error"], ["rate", /rate limit/, "api_error"], ["boom", /Search Console API error \(500\)/, "api_error"]] as const) {
    await g.control({ gscMode: mode });
    const r = await c.tool("get_search_console_performance", { projectId: pid });
    assert.equal(r.structuredContent.ok, false); assert.equal(r.structuredContent.reason, reason); assert.match(r.content[0]!.text, re);
    assert.match(r.content[0]!.text, /reconnect at http/);
  }
  await g.control({ gscMode: "ok" });
  c.ctx.db.prepare("UPDATE google_grants SET expires_at=0").run(); await g.control({ revokeRefresh: true });
  const revoked = await c.tool("get_search_console_performance", { projectId: pid });
  assert.match(revoked.content[0]!.text, /expired or was revoked/);
});
test("inspect_urls: per-URL results, inline failures, language, limits", async () => {
  await useSite();
  const r = (await c.tool("inspect_urls", { projectId: pid, urls: ["https://example.com/a", "https://example.com/bad", "https://example.com/c"], languageCode: "en-US" })).structuredContent;
  assert.equal(r.ok, true); assert.equal(r.results.length, 3);
  assert.equal(r.results[0].result.indexStatusResult.verdict, "PASS"); assert.equal(r.results[1].result, null); assert.match(r.results[1].error, /Search Console API error \(400\)/);
  const b = g.stats().bodies["/v1/urlInspection/index:inspect"]!;
  assert.deepEqual([b[0].siteUrl, b[0].inspectionUrl, b[0].languageCode], ["sc-domain:example.com", "https://example.com/a", "en-US"]);
  assert.ok((await c.tool("inspect_urls", { projectId: pid, urls: [] })).isError); assert.ok((await c.tool("inspect_urls", { projectId: pid, urls: Array(11).fill("https://example.com/") })).isError);
  assert.ok((await c.tool("inspect_urls", { projectId: pid, urls: ["not a url"] })).isError, "uri format enforced");
  c.ctx.db.prepare("UPDATE google_grants SET expires_at=0").run(); await g.control({ revokeRefresh: true });
  assert.match((await c.tool("inspect_urls", { projectId: pid, urls: ["https://example.com/a"] })).content[0]!.text, /expired or was revoked/, "token failures abort the batch (reconnect needed)");
});

test("Analytics: property choice, metadata captured, foreign properties refused", async () => {
  await connect("ga4");
  const gid = await grantId("ga4");
  assert.deepEqual((await status()).ga4.accounts[0].properties.map((p: any) => p.propertyId), ["properties/111", "properties/222"]);
  assert.equal((await c.post("/api/google/ga4/select", { projectId: pid, grantId: gid, propertyId: "properties/999" })).status, 404);
  assert.equal((await c.post("/api/google/ga4/select", { projectId: pid, grantId: gid })).status, 400);
  assert.equal((await c.post("/api/google/ga4/select", { projectId: pid, grantId: gid, propertyId: "properties/111" })).status, 200);
  assert.deepEqual((await status()).ga4.connection, { propertyId: "properties/111", displayName: "Acme Web", timeZone: "America/New_York", email: "owner@example.com" });
  assert.equal((await c.app.request(`/api/google/ga4/${pid}`, { method: "DELETE" })).status, 204);
  assert.equal((await status()).ga4.connection, null);
});
test("every Analytics tool answers 'not connected' with a link, never an exception", async () => {
  for (const [t, a] of [["get_google_analytics_organic_landing_pages", {}], ["get_google_analytics_page_performance", {}], ["get_google_analytics_key_events", {}], ["get_google_analytics_organic_overview", {}], ["get_google_analytics_traffic_acquisition", {}], ["get_google_analytics_ecommerce_performance", {}], ["get_google_analytics_site_search", {}], ["get_google_analytics_audience_breakdown", {}], ["get_google_analytics_measurement_health", {}]] as const) {
    const r = await c.tool(t, { projectId: pid, ...a });
    assert.equal(r.structuredContent.status, "error", t); assert.equal(r.structuredContent.error.code, "ga4_not_connected");
    assert.match(r.structuredContent.error.actionUrl, /\/p\/[0-9a-f-]+\/settings\/integrations$/); assert.match(r.content[0]!.text, /not connected for this project\. Continue here: http/);
  }
});

const lastRun = () => g.stats().bodies["/analyticsdata.googleapis.com/v1beta/properties/111:runReport".replace("/analyticsdata.googleapis.com", "")]!.at(-1);
const runs = () => g.stats().bodies["/v1beta/properties/111:runReport"]!;
test("Analytics reports: definitions, organic filter, order, paging, envelope", async () => {
  await useProperty();
  const r = (await c.tool("get_google_analytics_organic_landing_pages", { projectId: pid, limit: 5 })).structuredContent;
  const b = runs().at(-1);
  assert.deepEqual(b.dimensions, [{ name: "hostName" }, { name: "landingPage" }]);
  assert.deepEqual(b.metrics.map((m: any) => m.name), ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "sessionKeyEventRate", "transactions", "purchaseRevenue"]);
  assert.deepEqual(b.dimensionFilter, { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } });
  assert.deepEqual([b.limit, b.offset, b.orderBys, b.keepEmptyRows, b.returnPropertyQuota], ["5", "0", [{ metric: { metricName: "sessions" }, desc: true }], false, true]);
  assert.deepEqual([r.status, r.source, r.rowCount, r.totalRowCount, r.pageInfo], ["ok", { provider: "google_analytics", propertyId: "properties/111", propertyDisplayName: "Acme Web" }, 5, 12, { offset: 0, limit: 5, hasMore: true, nextOffset: 5 }]);
  assert.deepEqual([r.request.channel, r.request.reportKind, r.request.breakdown, r.request.propertyTimeZone, r.request.currencyCode], ["organic_search", "landing_pages", "landing_page", "America/New_York", "USD"]);
  assert.deepEqual(r.rows[0], { hostName: "example.com", landingPage: "/", sessions: 50, activeUsers: 50, engagedSessions: 50, engagementRate: 0.5, keyEvents: 50, sessionKeyEventRate: 0.5, transactions: 50, purchaseRevenue: 1000 });
  assert.equal(r.quota.tokensPerDay.remaining, 24995); assert.equal(r.reportMetadata.hasLimitedData, false);
  const p2 = (await c.tool("get_google_analytics_organic_landing_pages", { projectId: pid, limit: 5, offset: 10 })).structuredContent;
  assert.deepEqual([p2.rowCount, p2.pageInfo.hasMore, p2.pageInfo.nextOffset], [2, false, null]);
});
test("Analytics reports: each report kind sends the right dimensions, metrics and filters", async () => {
  await useProperty();
  const call = async (tool: string, args: Record<string, unknown> = {}) => { const r = await c.tool(tool, { projectId: pid, ...args }); assert.equal(r.structuredContent.status, "ok", tool + JSON.stringify(r.structuredContent)); return { r: r.structuredContent, b: runs().at(-1) }; };
  let x = await call("get_google_analytics_page_performance", { includeDate: true, channel: "all" });
  assert.deepEqual(x.b.dimensions.map((d: any) => d.name), ["hostName", "pagePath", "date"]); assert.equal(x.b.dimensionFilter, undefined, "channel=all removes the organic filter"); assert.equal(x.r.request.breakdown, "page_and_date");
  x = await call("get_google_analytics_key_events", { breakdown: "event_and_landing_page" });
  assert.deepEqual(x.b.dimensions.map((d: any) => d.name), ["eventName", "hostName", "landingPage"]);
  assert.deepEqual(x.b.metricFilter, { filter: { fieldName: "keyEvents", numericFilter: { operation: "GREATER_THAN", value: { doubleValue: 0 } } } });
  x = await call("get_google_analytics_traffic_acquisition", { breakdown: "campaign" });
  assert.deepEqual(x.b.dimensions, [{ name: "sessionCampaignName" }]); assert.equal(x.b.dimensionFilter, undefined, "acquisition always covers all channels"); assert.equal(x.r.request.channel, "all");
  x = await call("get_google_analytics_audience_breakdown", { breakdown: "country" });
  assert.deepEqual(x.b.dimensions, [{ name: "country" }]);
  x = await call("get_google_analytics_site_search");
  assert.deepEqual(x.b.dimensionFilter.andGroup.expressions.map((e: any) => e.filter?.stringFilter?.value ?? e.notExpression.filter.stringFilter.value), ["view_search_results", "(not set)"]);
  x = await call("get_google_analytics_ecommerce_performance", { breakdown: "landing_page", onlyWithTransactions: true });
  assert.deepEqual(x.b.dimensions.map((d: any) => d.name), ["hostName", "landingPage"]); assert.equal(x.b.metricFilter.filter.fieldName, "transactions"); assert.equal(x.b.orderBys[0].metric.metricName, "purchaseRevenue");
  assert.equal(x.r.request.flags.onlyWithTransactions, true);
  x = await call("get_google_analytics_ecommerce_performance");
  assert.deepEqual(x.b.dimensions.map((d: any) => d.name), ["itemName", "itemId"]); assert.equal(x.r.ecommerceActivity.status, "detected"); assert.deepEqual(x.r.diagnostics, []);
});
test("Analytics dates: default is the last 28 complete days in the property's time zone; end dates are clamped; bad input is explained", async () => {
  await useProperty();
  const ok = (await c.tool("get_google_analytics_key_events", { projectId: pid })).structuredContent;
  const { startDate, endDate } = ok.request.resolvedDateRange;
  assert.equal((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000, 27); assert.equal(ok.request.requestedDateRange, null);
  const future = (await c.tool("get_google_analytics_key_events", { projectId: pid, startDate: "2026-01-01", endDate: shiftDate(endDate, 10) })).structuredContent;
  assert.equal(future.request.resolvedDateRange.endDate, endDate); assert.deepEqual(future.warnings, ["end_date_clamped"]); assert.match((await c.tool("get_google_analytics_key_events", { projectId: pid, startDate: "2026-01-01", endDate: shiftDate(endDate, 10) })).content[0]!.text, /end date was moved to the last complete day/);
  const err = async (a: Record<string, unknown>) => (await c.tool("get_google_analytics_key_events", { projectId: pid, ...a })).structuredContent.error;
  assert.equal((await err({ startDate: "2026-01-01" })).message, "Provide both startDate and endDate, or neither.");
  assert.equal((await err({ startDate: "2026-02-30", endDate: "2026-03-01" })).code, "validation_error");
  assert.equal((await err({ startDate: "2026-03-02", endDate: "2026-03-01" })).message, "Dates must be valid YYYY-MM-DD values with startDate on or before endDate.");
  assert.equal((await err({ startDate: shiftDate(endDate, 5), endDate: shiftDate(endDate, 9) })).message, "The resolved startDate is after the last complete Analytics day.");
  assert.ok((await c.tool("get_google_analytics_key_events", { projectId: pid, limit: 0 })).isError, "schema bounds limit before the service sees it");
});
test("Analytics comparison: previous period of equal length, complete fetch, percent change", async () => {
  await useProperty();
  const r = (await c.tool("get_google_analytics_traffic_acquisition", { projectId: pid, comparePreviousPeriod: true, limit: 2 })).structuredContent;
  const [cur, prev] = runs().slice(-2).map((b: any) => b.dateRanges[0]);
  assert.equal(Date.parse(cur.startDate) - Date.parse(prev.endDate), 86_400_000, "previous window ends the day before"); assert.equal(inclusive(cur), inclusive(prev));
  assert.deepEqual(runs().at(-1).limit, "1000", "comparison fetches the full report");
  assert.equal(r.rowCount, 2); assert.equal(r.totalRowCount, 12);
  assert.deepEqual(r.comparison.dimensions, ["sessionDefaultChannelGroup"]); assert.equal(r.comparison.rows.length, 5, "one comparison row per distinct channel group");
  const m = r.comparison.rows[0].metrics.sessions;
  assert.deepEqual(Object.keys(m), ["current", "previous", "absoluteChange", "percentChange"]); assert.ok(m.absoluteChange > 0 && Math.abs(m.percentChange - m.absoluteChange / m.previous) < 1e-9);
  assert.equal(r.comparison.coverage.complete, true); assert.deepEqual(r.warnings, []);
  const bad = (await c.tool("get_google_analytics_traffic_acquisition", { projectId: pid, breakdown: "campaign", comparePreviousPeriod: true })).structuredContent.error;
  assert.equal(bad.code, "validation_error"); assert.match(bad.message, /only available for event key events/);
  await g.control({ ga4Rows: 1500 });
  const big = (await c.tool("get_google_analytics_key_events", { projectId: pid, comparePreviousPeriod: true })).structuredContent;
  assert.equal(big.comparison.coverage.complete, false); assert.deepEqual(big.warnings, ["comparison_incomplete"]);
});
const inclusive = (r: { startDate: string; endDate: string }) => (Date.parse(r.endDate) - Date.parse(r.startDate)) / 86_400_000 + 1;
test("Analytics source/medium diagnostics: unattributed share, internal referrals, case variants", async () => {
  await useProperty();
  const r = (await c.tool("get_google_analytics_traffic_acquisition", { projectId: pid, breakdown: "source_medium" })).structuredContent;
  assert.deepEqual(r.diagnostics.map((d: any) => d.code).sort(), ["attribution_not_set_share_high", "internal_referral_traffic_detected", "source_medium_case_variants_detected"]);
  assert.deepEqual(r.diagnostics.find((d: any) => d.code === "source_medium_case_variants_detected").evidence.variantGroups, [["Google / organic", "google / organic"]]);
  assert.equal(r.diagnosticCoverage.complete, true);
  await g.control({ ga4Mode: "limited" });
  const limited = (await c.tool("get_google_analytics_traffic_acquisition", { projectId: pid, breakdown: "source_medium" })).structuredContent;
  assert.deepEqual(limited.diagnostics, []); assert.equal(limited.reportMetadata.hasLimitedData, true); assert.equal(limited.diagnosticCoverage.limitedData, true);
});
test("Analytics ecommerce and site-search activity status: none, unknown, detected", async () => {
  await useProperty();
  await g.control({ ga4Mode: "empty" });
  const none = (await c.tool("get_google_analytics_site_search", { projectId: pid })).structuredContent;
  assert.equal(none.siteSearchActivity.status, "none"); assert.deepEqual(none.diagnostics.map((d: any) => d.code), ["no_site_search_activity"]); assert.equal(none.rowCount, 0);
  assert.equal((await c.tool("get_google_analytics_ecommerce_performance", { projectId: pid })).structuredContent.diagnostics[0].code, "no_ecommerce_activity");
  await g.control({ ga4Mode: "limited" });
  assert.equal((await c.tool("get_google_analytics_site_search", { projectId: pid })).structuredContent.siteSearchActivity.status, "unknown");
  await g.control({ ga4Mode: "ok" });
  assert.equal((await c.tool("get_google_analytics_site_search", { projectId: pid })).structuredContent.siteSearchActivity.status, "detected");
});
test("Analytics response handling: restricted metrics become null; headerless empty reports are fine; mismatched or non-numeric data is rejected", async () => {
  await useProperty();
  await g.control({ ga4Mode: "restricted" });
  const r = (await c.tool("get_google_analytics_organic_landing_pages", { projectId: pid, limit: 2 })).structuredContent;
  assert.equal(r.rows[0].purchaseRevenue, null); assert.equal(typeof r.rows[0].sessions, "number"); assert.deepEqual(r.reportMetadata.restrictedMetrics, [{ metricName: "purchaseRevenue", restrictedMetricTypes: ["REVENUE_DATA"] }]);
  await g.control({ ga4Mode: "headerless" });
  const empty = (await c.tool("get_google_analytics_organic_landing_pages", { projectId: pid })).structuredContent;
  assert.deepEqual([empty.status, empty.rowCount, empty.totalRowCount], ["ok", 0, 0]);
  for (const mode of ["mismatch", "nan"]) { await g.control({ ga4Mode: mode }); assert.equal((await c.tool("get_google_analytics_organic_landing_pages", { projectId: pid })).structuredContent.error.code, "ga4_malformed_response", mode); }
});
test("Analytics errors map to stable codes with the right action link and retry hint", async () => {
  await useProperty();
  const expect: [string, string, number | undefined, boolean][] = [["quota", "ga4_quota_exhausted", 120, false], ["disabled", "ga4_upstream_unavailable", undefined, false], ["gone", "ga4_property_inaccessible", undefined, true], ["bad", "ga4_report_incompatible", undefined, false], ["boom", "ga4_upstream_unavailable", undefined, false]];
  for (const [mode, code, retry, link] of expect) {
    await g.control({ ga4Mode: mode });
    const e = (await c.tool("get_google_analytics_key_events", { projectId: pid })).structuredContent.error;
    assert.equal(e.code, code, mode); assert.equal(e.retryAfterSeconds ?? undefined, retry, mode); assert.equal(Boolean(e.actionUrl), link, mode);
  }
  await g.control({ ga4Mode: "disabled" });
  assert.match((await c.tool("get_google_analytics_key_events", { projectId: pid })).structuredContent.error.message, /Data API is not enabled for this OAuth application/);
  await g.control({ ga4Mode: "ok" }); c.ctx.db.prepare("UPDATE google_grants SET expires_at=0").run(); await g.control({ revokeRefresh: true });
  const e = (await c.tool("get_google_analytics_key_events", { projectId: pid })).structuredContent.error;
  assert.equal(e.code, "ga4_reconnect_required"); assert.match(e.actionUrl, /settings\/integrations/);
});
test("get_google_analytics_organic_overview: totals, previous period, comparison, trend, sharp-decline diagnostic", async () => {
  await useProperty();
  const r = (await c.tool("get_google_analytics_organic_overview", { projectId: pid, trend: "weekly" })).structuredContent;
  assert.equal(runs().length, 3, "current, previous and trend are three requests");
  const [cur, prev, trend] = runs().slice(-3);
  assert.deepEqual([cur.dimensions, cur.limit, trend.dimensions, trend.limit], [[], "1", [{ name: "yearWeek" }], "1000"]);
  assert.equal(Date.parse(cur.dateRanges[0].startDate) - Date.parse(prev.dateRanges[0].endDate), 86_400_000);
  assert.deepEqual(Object.keys(r.comparison), ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"]);
  assert.equal(r.trend.length, 12); assert.equal(r.request.trend, "weekly"); assert.equal(r.request.channel, "organic_search"); assert.ok(r.comparison.sessions.percentChange > 0);
  assert.deepEqual(r.diagnostics, []);
  assert.match((await c.tool("get_google_analytics_organic_overview", { projectId: pid })).content[0]!.text, /Organic overview for \d{4}-\d{2}-\d{2} through/);
  assert.equal(runs().at(-1).dimensions[0].name, "date", "daily trend by default");
});
test("get_google_analytics_measurement_health: streams, enhanced measurement, key events, custom definitions, issue list", async () => {
  await useProperty();
  let r = (await c.tool("get_google_analytics_measurement_health", { projectId: pid })).structuredContent;
  assert.deepEqual(r.summary, { dataStreamCount: 2, webStreamCount: 1, keyEventCount: 1, customDimensionCount: 1, customMetricCount: 0, issueCount: 1 });
  assert.deepEqual(r.issues, ["site_search_measurement_disabled"]);
  assert.deepEqual([r.webStreams[0].streamId, r.webStreams[0].measurementId, r.webStreams[0].defaultUri], ["9001", "G-ABC123", "https://example.com"]);
  assert.deepEqual(r.otherStreams, [{ streamId: "9002", type: "ANDROID_APP_DATA_STREAM", displayName: "Android" }]);
  assert.equal(r.source.provider, "google_analytics_admin");
  await g.control({ em: false, noKeyEvents: true });
  r = (await c.tool("get_google_analytics_measurement_health", { projectId: pid })).structuredContent;
  assert.deepEqual(r.issues, ["enhanced_measurement_disabled", "site_search_measurement_disabled", "no_key_events_configured"]);
  await g.control({ ga4Mode: "admin403" });
  assert.equal((await c.tool("get_google_analytics_measurement_health", { projectId: pid })).structuredContent.error.code, "ga4_property_inaccessible");
});
test("get_search_opportunities: joins Search Console pages to Analytics landing pages and ranks by demand, value and reach", async () => {
  await useSite(); await useProperty();
  const r = (await c.tool("get_search_opportunities", { projectId: pid, limit: 5 })).structuredContent;
  assert.equal(r.status, "ok"); assert.deepEqual(r.source, { searchConsoleSiteUrl: "sc-domain:example.com", googleAnalyticsPropertyId: "properties/111", googleAnalyticsPropertyDisplayName: "Acme Web" });
  assert.equal(r.rowCount, 5); assert.ok(r.totalCandidateRows >= 5);
  assert.ok(r.rows.every((x: any) => x.position >= 4 && x.position <= 20), "only striking-distance pages are candidates");
  const joined = r.rows.filter((x: any) => x.joinStatus === "joined");
  assert.ok(joined.length > 0 && joined.every((x: any) => x.score >= 0 && x.score <= 100 && x.scoreComponents), "joined rows are scored");
  assert.deepEqual(r.rows.map((x: any) => x.score ?? -1), [...r.rows.map((x: any) => x.score ?? -1)].sort((a, b) => b - a), "sorted by score, unscored last");
  assert.equal(r.scoring.formula, "round(100 * (0.5 * demand + 0.3 * businessValue + 0.2 * reachability))");
  assert.deepEqual(r.warnings, ["source_time_zones_differ"], "New York vs the Search Console's Pacific time");
  const sc = g.stats().bodies["/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"]!.at(-1);
  assert.deepEqual([sc.dimensions, sc.rowLimit, sc.dataState], [["page"], 1000, "final"]);
  c.ctx.db.prepare("DELETE FROM gsc_connections").run();
  assert.equal((await c.tool("get_search_opportunities", { projectId: pid })).structuredContent.error.code, "gsc_not_connected");
  c.ctx.db.prepare("DELETE FROM ga4_connections").run();
  assert.equal((await c.tool("get_search_opportunities", { projectId: pid })).structuredContent.error.code, "ga4_not_connected");
});

test("deleting a project removes its Google connections but keeps the account grant for other projects", async () => {
  await useSite(); await useProperty();
  assert.equal((await c.app.request(`/api/projects/${pid}`, { method: "DELETE" })).status, 204);
  for (const t of ["gsc_connections", "ga4_connections"]) assert.equal((c.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n, 0, t);
  assert.equal((c.ctx.db.prepare("SELECT COUNT(*) AS n FROM google_grants").get() as any).n, 2);
});
test("tool links in results open the right screen of the UI", async () => {
  const cases: [string, string][] = [[`/p/${pid}/keywords`, `/#/p/${pid}/keywords`], [`/p/${pid}/search-performance`, `/#/p/${pid}/integrations`], [`/p/${pid}/settings/integrations`, `/#/p/${pid}/integrations`], [`/p/${pid}/rank-tracking/abc`, `/#/p/${pid}/rank/abc`], [`/p/${pid}/reports/templates`, `/#/p/${pid}/reports`], [`/p/${pid}/reports/r1`, `/#/p/${pid}/reports/r1`], [`/p/${pid}/audit/issues/a1`, `/#/p/${pid}/audit/a1`], [`/p/${pid}`, `/#/p/${pid}/keywords`], [`/p/${pid}/nonsense`, `/#/p/${pid}/keywords`]];
  for (const [from, to] of cases) assert.equal((await c.get(from)).headers.get("location"), to, from);
});
