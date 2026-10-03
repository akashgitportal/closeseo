import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeDfs, type FakeDfs } from "./support/fake-dataforseo.ts";
import { makeClient, makeCtx } from "./support/harness.ts";

let dfs: FakeDfs;
before(async () => { dfs = await startFakeDfs(); });
after(() => dfs.close());

test("health reports mode and configuration without leaking secrets", async () => {
  const c = makeClient(makeCtx({ dfsUrl: dfs.url }));
  const h = (await (await c.get("/api/health")).json()) as any;
  assert.deepEqual([h.status, h.version, h.authMode, h.checks.dataforseo.status, h.checks.database.status], ["ok", "0.1.0", "local_noauth", "ok", "ok"]);
  assert.ok(!JSON.stringify(h).includes("fake"), "no key material in health output");
  const nk = makeClient(makeCtx({ noKey: true }));
  assert.equal(((await (await nk.get("/api/health")).json()) as any).checks.dataforseo.status, "warn");
});
test("api_key mode: /api and /mcp require the bearer token; health stays open", async () => {
  const c = makeClient(makeCtx({ AUTH_MODE: "api_key", CLOSESEO_API_KEY: "s3cret-token-value" }));
  assert.equal((await c.get("/api/health")).status, 200);
  for (const bad of [{}, { authorization: "Bearer nope" }, { authorization: "Basic s3cret-token-value" }, { authorization: "Bearer s3cret-token-valu" }, { authorization: "Bearer s3cret-token-value-x" }]) {
    assert.equal((await c.get("/api/projects", bad)).status, 401, JSON.stringify(bad));
    assert.equal((await c.post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, bad)).status, 401);
  }
  const ok = { authorization: "Bearer s3cret-token-value" };
  assert.equal((await c.get("/api/projects", ok)).status, 200);
  assert.equal((await c.post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, ok)).status, 200);
  const r = await c.get("/api/projects"); assert.equal(r.headers.get("www-authenticate"), "Bearer");
  assert.equal(((await r.json()) as any).error.code, "UNAUTHENTICATED");
});
test("projects REST: CRUD, validation and error shape", async () => {
  const c = makeClient(makeCtx({ dfsUrl: dfs.url }));
  assert.equal((await c.post("/api/projects", { domain: "x.com" })).status, 400);
  assert.equal((await c.app.request("/api/projects", { method: "POST", body: "nope", headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await c.app.request("/api/projects", { method: "POST", body: "[1]", headers: { "content-type": "application/json" } })).status, 400);
  const made = await c.post("/api/projects", { name: "A", domain: "https://A.com/x" });
  assert.equal(made.status, 201);
  const { project } = (await made.json()) as any;
  assert.equal(project.domain, "a.com");
  const patched = (await (await c.app.request(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ name: "B", locationCode: 2250 }), headers: { "content-type": "application/json" } })).json()) as any;
  assert.deepEqual([patched.project.name, patched.project.languageCode, patched.project.domain], ["B", "fr", "a.com"]);
  const cleared = (await (await c.app.request(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ domain: null }), headers: { "content-type": "application/json" } })).json()) as any;
  assert.equal(cleared.project.domain, null);
  assert.equal((await c.app.request(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ name: "" }), headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await c.get("/api/projects/nope")).status, 404);
  assert.equal((await c.app.request(`/api/projects/${project.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await c.app.request(`/api/projects/${project.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await c.get("/api/nothing")).status, 404);
});
test("REST tool bridge mirrors MCP results and maps errors to HTTP status", async () => {
  const c = makeClient(makeCtx({ dfsUrl: dfs.url }));
  const p = (await (await c.post("/api/tools/create_project", { name: "T" })).json()) as any;
  assert.ok(p.data.project.id);
  assert.equal((await c.post("/api/tools/get_project_context", { projectId: "00000000-0000-0000-0000-000000000000" })).status, 404);
  assert.equal((await c.post("/api/tools/create_project", {})).status, 400);
  const local = await c.post("/api/tools/search_local_businesses", { projectId: p.data.project.id, near: { latitude: 1, longitude: 2, radiusKm: 5 } });
  assert.equal(local.status, 200);
  assert.ok(Array.isArray(((await local.json()) as any).data.businesses));
  assert.equal((await c.post("/api/tools/bogus", {})).status, 404);
  assert.equal((await c.post("/api/tools/list_projects", [])).status, 400);
});
test("public share links: sandboxed, noindex, revocable, token-validated", async () => {
  const c = makeClient(makeCtx({ dfsUrl: dfs.url, PUBLIC_URL: "https://seo.example.org", ENABLE_PUBLIC_SHARING: "1" }));
  const pid = (await c.tool("create_project", { name: "S" })).structuredContent.project.id;
  const rep = (await c.tool("save_report", { projectId: pid, title: "<b>Title</b> & co", summary: "s", html: "<html><h1>Report</h1><script>alert(1)</script></html>" })).structuredContent;
  assert.match(rep.url, /^https:\/\/seo\.example\.org\/p\//);
  const sh = (await c.tool("set_report_sharing", { projectId: pid, reportId: rep.reportId, public: true })).structuredContent;
  const token = sh.shareUrl.split("/").pop();
  const wrapper = await c.get(`/s/${token}`);
  const wtxt = await wrapper.text();
  assert.equal(wrapper.status, 200); assert.ok(wtxt.includes("&lt;b&gt;Title&lt;/b&gt; &amp; co"), "title escaped"); assert.ok(!wtxt.includes("<b>Title"));
  assert.match(wtxt, /sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  const raw = await c.get(`/s/${token}/raw`);
  assert.equal(raw.status, 200);
  const csp = raw.headers.get("content-security-policy")!;
  assert.match(csp, /sandbox/); assert.match(csp, /default-src 'none'/); assert.ok(!csp.includes("script-src")); assert.match(csp, /img-src data:;/);
  assert.equal(raw.headers.get("x-robots-tag"), "noindex"); assert.equal(raw.headers.get("cache-control"), "no-store");
  assert.equal((await c.get("/s/short")).status, 404); assert.equal((await c.get("/s/" + "a".repeat(32))).status, 404);
  assert.equal((await c.get("/s/..%2f..%2fetc")).status, 404);
  assert.equal((await c.get(`/r/${rep.reportId}`)).status, 302);
  await c.tool("set_report_sharing", { projectId: pid, reportId: rep.reportId, public: false });
  assert.equal((await c.get(`/s/${token}`)).status, 404); assert.equal((await c.get(`/s/${token}/raw`)).status, 404);
  assert.equal((await c.get("/r/missing")).status, 404);
});
test("shared links work without auth even in api_key mode (that is their purpose)", async () => {
  const c = makeClient(makeCtx({ dfsUrl: dfs.url, AUTH_MODE: "api_key", CLOSESEO_API_KEY: "k", ENABLE_PUBLIC_SHARING: "1" }));
  const h = { authorization: "Bearer k" };
  const pid = ((await (await c.post("/api/tools/create_project", { name: "S" }, h)).json()) as any).data.project.id;
  const rep = ((await (await c.post("/api/tools/save_report", { projectId: pid, title: "t", summary: "s", html: "<html><p>x</p></html>" }, h)).json()) as any).data;
  const sh = ((await (await c.post("/api/tools/set_report_sharing", { projectId: pid, reportId: rep.reportId, public: true }, h)).json()) as any).data;
  assert.equal((await c.get("/s/" + sh.shareUrl.split("/").pop())).status, 200);
});
test("static UI: served with security headers; path traversal is blocked", async () => {
  const c = makeClient(makeCtx());
  const idx = await c.get("/");
  assert.equal(idx.status, 200); assert.match(await idx.text(), /<title>CloseSEO<\/title>/);
  assert.equal(idx.headers.get("x-content-type-options"), "nosniff");
  assert.match(idx.headers.get("content-security-policy")!, /frame-ancestors 'self'/);
  assert.equal((await c.get("/app.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
  for (const p of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/etc/passwd", "/../package.json", "/nope.txt"]) assert.equal((await c.get(p)).status, 404, p);
});
test("oversized bodies are rejected", async () => {
  const c = makeClient(makeCtx());
  const big = JSON.stringify({ name: "x".repeat(2_100_000) });
  assert.equal((await c.app.request("/api/projects", { method: "POST", body: big, headers: { "content-type": "application/json", "content-length": String(big.length) } })).status, 413);
  assert.equal((await c.app.request("/mcp", { method: "POST", body: big, headers: { "content-type": "application/json", "content-length": String(big.length) } })).status, 413);
});

test("public sharing is off by default: refused with a clear message, and share routes 404", async () => {
  const c = makeClient(makeCtx({ dfsUrl: dfs.url }));
  const pid = (await c.tool("create_project", { name: "S" })).structuredContent.project.id;
  const rep = (await c.tool("save_report", { projectId: pid, title: "t", summary: "s", html: "<html></html>" })).structuredContent.reportId;
  const r = await c.tool("set_report_sharing", { projectId: pid, reportId: rep, public: true });
  assert.ok(r.isError); assert.match(r.content[0]!.text, /ENABLE_PUBLIC_SHARING=1/);
  assert.ok(!(await c.tool("set_report_sharing", { projectId: pid, reportId: rep, public: false })).isError, "unsharing always works");
  assert.equal((await c.get("/s/" + "a".repeat(32))).status, 404);
});
