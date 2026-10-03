import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFakeDfs, type FakeDfs } from "../support/fake-dataforseo.ts";
import { startFixtureSite } from "../support/fixture-site.ts";
import { FAKE_KEY, until } from "../support/harness.ts";

let dfs: FakeDfs, site: Awaited<ReturnType<typeof startFixtureSite>>, proc: ChildProcess, browser: Browser, page: Page, base: string;
const dir = mkdtempSync(join(tmpdir(), "closeseo-ui-"));
const errors: string[] = [];

before(async () => {
  dfs = await startFakeDfs(); site = await startFixtureSite();
  const port = 30000 + Math.floor(Math.random() * 9000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, "ui.db"), DATAFORSEO_API_KEY: FAKE_KEY, DATAFORSEO_BASE_URL: dfs.url, ALLOW_PRIVATE_AUDIT_TARGETS: "1", DISABLE_SCHEDULER: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; proc.stdout!.on("data", (d) => (out += d));
  await until(() => out.includes("listening"), 10000);
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => void d.accept());
});
after(async () => { await browser?.close(); proc?.kill("SIGKILL"); await dfs.close(); await site.close(); rmSync(dir, { recursive: true, force: true }); });

const tab = (name: string) => page.locator("nav.tabs a", { hasText: name }).click();

test("create a project; markup in its name is rendered as text, never executed", async () => {
  await page.goto(base);
  await page.waitForSelector("h1");
  assert.equal(await page.textContent("h1"), "Projects");
  await page.fill('input[name="name"]', '<img src=x onerror="window.__xss=1"> Acme');
  await page.fill('input[name="domain"]', "example.com");
  await page.click('button:has-text("Create")');
  await page.waitForSelector("nav.tabs");
  assert.match((await page.textContent("h1"))!, /<img src=x onerror="window.__xss=1"> Acme/);
  assert.equal(await page.evaluate(() => (window as any).__xss), undefined);
});

test("keyword research -> save selected -> appears under Saved with tags and metrics", async () => {
  await tab("Keywords");
  await page.fill('input[name="seed"]', "seo tools");
  await page.click('button:has-text("Research")');
  await page.waitForSelector("table tbody tr");
  assert.match((await page.textContent("p.muted"))!, /keywords · source blended/);
  await page.locator("tbody tr input[type=checkbox]").nth(0).check();
  await page.locator("tbody tr input[type=checkbox]").nth(1).check();
  await page.click('button:has-text("Save selected")');
  await page.waitForSelector("#toast.show");
  await tab("Saved");
  await page.waitForFunction(() => /\d+ saved/.test(document.querySelector("p.muted")?.textContent ?? ""));
  assert.equal(await page.locator("tbody tr").count(), 2);
  assert.ok((await page.textContent("tbody tr"))!.match(/\d/), "metrics carried over");
  await page.fill('textarea[name="kws"]', "manual one\nmanual two");
  await page.fill('input[name="tags"]', "alpha, beta");
  await page.click('button:has-text("Add")');
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 4);
  assert.match((await page.textContent("p.muted"))!, /alpha \(2\)/);
  await page.locator("tbody tr button.danger").first().click();
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 3);
});

test("domain, backlinks and SERP views render provider data", async () => {
  await tab("Domain");
  await page.click('button:has-text("Analyze")');
  await page.waitForSelector(".grid .stat");
  await page.waitForSelector("table tbody tr");
  assert.match((await page.textContent("main"))!, /Organic traffic/);
  assert.match((await page.textContent("table tbody tr"))!, /example topic 1/);
  await tab("Backlinks");
  await page.click('button:has-text("Fetch")');
  await page.waitForSelector("h2:has-text('Backlinks (')");
  assert.match((await page.textContent("main"))!, /Top referring domains/);
  await tab("SERP");
  await page.fill('textarea[name="kw"]', "seo tools");
  await page.click('button:has-text("Fetch SERP")');
  await page.waitForSelector(".card table tbody tr");
  assert.ok((await page.locator(".card table tbody tr").count()) >= 10);
});

test("rank tracking: create, add keywords, run a live check, see positions", async () => {
  await tab("Rank tracking");
  await page.selectOption('select[name="devices"]', "both");
  await page.click('button:has-text("Create")');
  await page.waitForSelector('textarea[name="kws"]');
  await page.fill('textarea[name="kws"]', "seo tools\nunranked thing");
  await page.click('button:has-text("Add keywords")');
  await page.waitForSelector("table tbody tr");
  await page.click('button:has-text("Run now")');
  await page.waitForFunction(() => /Last run completed/.test(document.body.textContent ?? ""), null, { timeout: 15000 }).catch(async () => { await page.click('button:has-text("Refresh")'); await page.waitForFunction(() => /Last run completed/.test(document.body.textContent ?? ""), null, { timeout: 15000 }); });
  const rows = await page.locator("tbody tr").allTextContents();
  assert.ok(rows.some((r) => /seo tools/.test(r) && /\d/.test(r)));
  assert.ok(rows.some((r) => /unranked thing/.test(r) && />40/.test(r)), "unranked keyword shows > depth");
});

test("site audit: run against a local fixture, watch it finish, open the issue list", async () => {
  await tab("Site audit");
  await page.fill('input[name="url"]', site.url);
  await page.fill('input[name="max"]', "20");
  await page.click('button:has-text("Run audit")');
  await page.waitForFunction(() => /completed/.test(document.querySelector("table")?.textContent ?? ""), null, { timeout: 30000 });
  await page.locator("table a").first().click();
  await page.waitForSelector("h2:has-text('Issues')");
  assert.match((await page.textContent("main"))!, /critical|warning/);
  assert.match((await page.textContent("main"))!, /No meta description|Little text|answers with a 4xx/);
});

test("context: save a section and see it persisted after reload", async () => {
  await tab("Context");
  const ta = page.locator('textarea[name="content"]').first();
  await ta.fill("We sell widgets");
  await page.locator('button:has-text("Save")').first().click();
  await page.waitForSelector("#toast.show");
  await page.reload();
  await page.waitForSelector('textarea[name="content"]');
  assert.equal(await page.locator('textarea[name="content"]').first().inputValue(), "We sell widgets");
});

test("reports created through the API are listed and rendered inside a sandboxed iframe", async () => {
  const pid = page.url().match(/#\/p\/([^/]+)/)![1]!;
  const html = '<html><body><h1>Agent report</h1><script>window.parent.__pwned = 1</script></body></html>';
  const r = await fetch(`${base}/api/tools/save_report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: pid, title: "Weekly", summary: "s", html }) });
  assert.equal(r.status, 200);
  await tab("Reports");
  await page.locator("table a", { hasText: "Weekly" }).click();
  await page.waitForSelector("iframe");
  assert.equal(await page.getAttribute("iframe", "sandbox"), "");
  const frame = page.frameLocator("iframe");
  assert.match((await frame.locator("h1").textContent()) ?? "", /Agent report/);
  assert.equal(await page.evaluate(() => (window as any).__pwned), undefined, "report script cannot reach the app");
  await page.click('button:has-text("Share publicly")');
  await page.waitForSelector("#toast.show");
  assert.match((await page.textContent("#toast"))!, /switched off/i, "sharing is off by default and says why");
});

test("settings: rename then delete the project", async () => {
  await tab("Settings");
  await page.fill('input[name="name"]', "Renamed");
  await page.click('button:has-text("Save")');
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Renamed");
  await tab("Settings");
  await page.click('button:has-text("Delete project")');
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Projects");
  assert.match((await page.textContent("main"))!, /No projects yet/);
});

test("no uncaught page errors; the only console errors are the two expected security refusals", () => {
  const unexpected = errors.filter((e) => !/Blocked script execution in 'about:srcdoc'/.test(e) && !/status of 422/.test(e));
  assert.deepEqual(unexpected, []);
  assert.ok(errors.some((e) => /Blocked script execution/.test(e)), "the report's script really was blocked");
});
