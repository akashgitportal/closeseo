import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFixtureSite } from "./support/fixture-site.ts";
import { startFakeDfs, type FakeDfs } from "./support/fake-dataforseo.ts";
import { makeClient, makeCtx, until } from "./support/harness.ts";
import { awaitAudits, failInterruptedAudits } from "../src/services/audit.ts";

let site: Awaited<ReturnType<typeof startFixtureSite>>;
let dfs: FakeDfs;
let c: ReturnType<typeof makeClient>;
let pid: string;
before(async () => { site = await startFixtureSite(); dfs = await startFakeDfs(); });
after(async () => { await site.close(); await dfs.close(); });
beforeEach(async () => {
  site.hits.clear();
  c = makeClient(makeCtx({ dfsUrl: dfs.url }));
  pid = (await c.tool("create_project", { name: "Audit", domain: "example.com" })).structuredContent.project.id;
});

async function audit(args: Record<string, unknown> = {}) {
  const r = await c.tool("run_site_audit", { projectId: pid, url: site.url, maxPages: 200, ...args });
  assert.ok(!r.isError, r.content[0]?.text);
  await awaitAudits();
  return r.structuredContent.auditId as string;
}
const issues = async (auditId: string, extra: Record<string, unknown> = {}) =>
  (await c.tool("get_audit_issues", { projectId: pid, auditId, limit: 1000, ...extra })).structuredContent;
const types = (i: { issues: { type: string; url: string }[] }) => new Set(i.issues.map((x) => x.type));

test("full crawl finds the planted problems and respects robots.txt", async () => {
  const id = await audit();
  const st = (await c.tool("get_audit_status", { projectId: pid, auditId: id })).structuredContent.status;
  assert.equal(st.status, "completed"); assert.ok(st.pagesCrawled > 70, `crawled ${st.pagesCrawled}`);
  const iss = await issues(id);
  for (const t of ["page_not_found", "page_server_error", "title_duplicate", "broken_internal_link", "redirect_chain", "redirect_loop", "low_word_count", "images_missing_alt", "noindex", "blocked_by_robots", "sitemap_missing"].filter((t) => t !== "sitemap_missing")) assert.ok(types(iss).has(t), `missing issue ${t}`);
  assert.ok(!types(iss).has("sitemap_missing") && !types(iss).has("robots_txt_missing"), "site has both");
  assert.equal(site.hits.get("/private/secret"), undefined, "robots-disallowed URL must never be requested");
  assert.ok(site.hits.get("/only-in-sitemap"), "sitemap-only URL is discovered");
  assert.equal(site.hits.get("/file.pdf"), undefined, "non-HTML extensions are not fetched");
  assert.equal(site.hits.get("/nofollow-only"), undefined, "rel=nofollow links are not followed");
  assert.ok(!iss.issues.some((x: any) => x.url.includes("external.invalid")), "external links are not crawled");
  assert.equal(site.hits.get("/robots.txt"), 1, "robots.txt fetched once");
  const pages = (await c.tool("get_audit_pages", { projectId: pid, auditId: id, limit: 1000 })).structuredContent;
  assert.equal(pages.total, st.pagesCrawled);
  const blocked = (await c.tool("get_audit_pages", { projectId: pid, auditId: id, fetchClass: "blocked" })).structuredContent;
  assert.ok(blocked.pages.some((p: any) => p.url.endsWith("/private/secret") && p.statusCode === null));
  assert.ok((await c.tool("get_audit_pages", { projectId: pid, auditId: id, fetchClass: "rate_limited" })).structuredContent.pages.some((p: any) => p.url.endsWith("/rate")));
  assert.ok((await c.tool("get_audit_pages", { projectId: pid, auditId: id, statusCode: 404 })).structuredContent.pages.every((p: any) => p.statusCode === 404));
  assert.ok((await c.tool("get_audit_pages", { projectId: pid, auditId: id, urlContains: "/p/1" })).structuredContent.total >= 1);
  assert.equal((await c.tool("get_audit_pages", { projectId: pid, auditId: id, urlContains: "%" })).structuredContent.total, 0, "LIKE wildcard escaped");
});
test("issue filters, severity ordering and summary counts agree", async () => {
  const id = await audit();
  const all = await issues(id);
  const sev = await issues(id, { severity: "critical" });
  assert.ok(sev.issues.length > 0 && sev.issues.every((x: any) => x.severity === "critical"));
  const byType = await issues(id, { issueType: "title_duplicate" });
  assert.deepEqual(byType.issues.map((x: any) => x.url.replace(site.url, "")).sort(), ["/dup1", "/dup2"]);
  const total = all.summary.reduce((n: number, s: any) => n + s.count, 0);
  assert.equal(total, all.issues.length);
  const order = all.summary.map((s: any) => s.severity);
  assert.deepEqual(order, [...order].sort((a, b) => ["critical", "warning", "info"].indexOf(a) - ["critical", "warning", "info"].indexOf(b)));
  const counts = (await c.tool("get_audit_status", { projectId: pid, auditId: id })).structuredContent.status.issueCounts;
  assert.equal(counts.critical + counts.warning + counts.info, total);
  assert.equal((await issues(id, { limit: 3 })).issues.length, 3);
});
test("maxPages is a hard cap", async () => {
  const id = await audit({ maxPages: 10 });
  const st = (await c.tool("get_audit_status", { projectId: pid, auditId: id })).structuredContent.status;
  assert.equal(st.pagesCrawled, 10); assert.equal(st.status, "completed");
  assert.equal((await c.tool("get_audit_pages", { projectId: pid, auditId: id, limit: 100 })).structuredContent.total, 10);
  assert.ok((await c.tool("run_site_audit", { projectId: pid, url: site.url, maxPages: 9 })).isError, "schema minimum is 10");
  assert.ok((await c.tool("run_site_audit", { projectId: pid, url: site.url, maxPages: 10001 })).isError, "schema maximum is 10000");
});
test("status defaults to the latest audit; list/delete work; unknown ids 404", async () => {
  const a = await audit({ maxPages: 10 });
  const b = await audit({ maxPages: 11 });
  assert.equal((await c.tool("get_audit_status", { projectId: pid })).structuredContent.status.id, b);
  assert.deepEqual((await c.tool("list_site_audits", { projectId: pid })).structuredContent.audits.map((x: any) => x.id), [b, a]);
  assert.equal((await c.tool("delete_site_audit", { projectId: pid, auditId: b })).structuredContent.deleted, true);
  assert.equal((await c.tool("get_audit_status", { projectId: pid })).structuredContent.status.id, a);
  assert.equal((c.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_pages WHERE audit_id=?").get(b) as { n: number }).n, 0, "pages cascade");
  assert.equal((await c.tool("get_audit_status", { projectId: pid, auditId: "00000000-0000-0000-0000-000000000000" })).content[0]!.text, "NOT_FOUND");
  const empty = (await c.tool("create_project", { name: "E" })).structuredContent.project.id;
  assert.ok((await c.tool("get_audit_status", { projectId: empty })).isError);
  const other = (await c.tool("create_project", { name: "Other" })).structuredContent.project.id;
  assert.equal((await c.tool("get_audit_status", { projectId: other, auditId: a })).content[0]!.text, "NOT_FOUND", "audits are project-scoped");
});
test("cancel stops a running audit and keeps it cancelled", async () => {
  const r = await c.tool("run_site_audit", { projectId: pid, url: site.url, maxPages: 200 });
  const id = r.structuredContent.auditId;
  await until(() => (c.ctx.db.prepare("SELECT pages_crawled AS n FROM audits WHERE id=?").get(id) as { n: number }).n >= 2);
  const res = await c.post("/api/audits/" + id + "/cancel", { projectId: pid });
  assert.deepEqual(await res.json(), { auditId: id, cancelled: true });
  await awaitAudits();
  const st = (await c.tool("get_audit_status", { projectId: pid, auditId: id })).structuredContent.status;
  assert.equal(st.status, "cancelled"); assert.ok(st.pagesCrawled < 70);
  assert.deepEqual(await (await c.post("/api/audits/" + id + "/cancel", { projectId: pid })).json(), { auditId: id, cancelled: false });
});
test("SSRF: private/loopback/metadata targets are refused unless explicitly allowed", async () => {
  const strict = makeClient(makeCtx({ dfsUrl: dfs.url, ALLOW_PRIVATE_AUDIT_TARGETS: "0" }));
  const p = (await strict.tool("create_project", { name: "S" })).structuredContent.project.id;
  for (const url of [site.url, "http://localhost:8080", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://10.0.0.5/", "file:///etc/passwd", "http://u:p@example.com/"]) {
    const r = await strict.tool("run_site_audit", { projectId: p, url });
    assert.ok(r.isError, url);
  }
  assert.equal(site.hits.size, 0, "nothing reached the private server");
  assert.ok((await strict.tool("run_site_audit", { projectId: p, url: site.url, renderJavaScript: true })).isError, "JS rendering unsupported is reported, not silently ignored");
});
test("a site that redirects into a private address is not followed there", async () => {
  const strict = makeClient(makeCtx({ dfsUrl: dfs.url, ALLOW_PRIVATE_AUDIT_TARGETS: "0" }));
  const p = (await strict.tool("create_project", { name: "S" })).structuredContent.project.id;
  const { createFetcher } = await import("../src/audit/fetcher.ts");
  const evil = await new Promise<import("node:http").Server>((resolve) => {
    import("node:http").then(({ createServer }) => { const s = createServer((_q, res) => { res.writeHead(302, { location: site.url + "/" }); res.end(); }); s.listen(0, "127.0.0.1", () => resolve(s)); });
  });
  try {
    const f = createFetcher({ allowPrivate: false });
    const r = await f(`http://127.0.0.1:${(evil.address() as any).port}/`);
    assert.equal(r.status, null); assert.match(r.error ?? "", /private|local|Blocked/i);
    assert.equal(site.hits.size, 0);
  } finally { evil.close(); void p; }
});
test("unreachable host and non-HTML start page fail gracefully, not by crashing", async () => {
  const id = await audit({ url: "http://127.0.0.1:1/" });
  const st = (await c.tool("get_audit_status", { projectId: pid, auditId: id })).structuredContent.status;
  assert.equal(st.status, "completed");
  const pg = (await c.tool("get_audit_pages", { projectId: pid, auditId: id })).structuredContent;
  assert.equal(pg.pages[0].fetchClass, "error"); assert.equal(pg.pages[0].statusCode, null);
});
test("Lighthouse via DataForSEO is stored on the audit; failures are recorded, not fatal", async () => {
  const id = await audit({ maxPages: 10, runLighthouse: true });
  const st = (await c.tool("get_audit_status", { projectId: pid, auditId: id })).structuredContent.status;
  assert.equal(st.lighthouse.scores.performance, 0.91);
  dfs.setMode("http503");
  const id2 = await audit({ maxPages: 10, runLighthouse: true });
  dfs.setMode("ok");
  const st2 = (await c.tool("get_audit_status", { projectId: pid, auditId: id2 })).structuredContent.status;
  assert.equal(st2.status, "completed"); assert.match(st2.lighthouse.error, /503/);
});
test("restart recovery fails audits that were mid-flight", async () => {
  c.ctx.db.prepare("INSERT INTO audits (id,project_id,start_url,status,max_pages,started_at) VALUES ('zombie',?,?,'running',5,?)").run(pid, site.url, new Date().toISOString());
  assert.equal(failInterruptedAudits(c.ctx), 1);
  const st = (await c.tool("get_audit_status", { projectId: pid, auditId: "zombie" })).structuredContent.status;
  assert.equal(st.status, "failed");
  const row = c.ctx.db.prepare("SELECT status,error_message FROM audits WHERE id='zombie'").get() as any;
  assert.equal(row.status, "failed"); assert.match(row.error_message, /restart/);
});
