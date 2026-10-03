import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFakeDfs, type FakeDfs } from "../support/fake-dataforseo.ts";
import { FAKE_KEY, until } from "../support/harness.ts";

let dfs: FakeDfs, proc: ChildProcess, browser: Browser, page: Page, base: string, pid: string;
const dir = mkdtempSync(join(tmpdir(), "closeseo-ai-ui-"));
const errors: string[] = [];

before(async () => {
  dfs = await startFakeDfs();
  const port = 30000 + Math.floor(Math.random() * 9000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, "ui.db"), DATAFORSEO_API_KEY: FAKE_KEY, DATAFORSEO_BASE_URL: dfs.url, DISABLE_SCHEDULER: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; proc.stdout!.on("data", (d) => (out += d));
  await until(() => out.includes("listening"), 10000);
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => void d.accept());
});
after(async () => { await browser?.close(); proc?.kill("SIGKILL"); await dfs.close(); rmSync(dir, { recursive: true, force: true }); });
const tab = (name: string) => page.locator("nav.tabs a", { hasText: name }).click();

test("a new project lands on the dashboard with its setup steps; steps can be hidden and shown again", async () => {
  await page.goto(base);
  await page.waitForSelector("h1");
  await page.fill('input[name="name"]', "Acme");
  await page.fill('input[name="domain"]', "acme.com");
  await page.click('button:has-text("Create")');
  await page.waitForSelector("nav.tabs");
  pid = page.url().split("/")[5]!;
  assert.match(page.url(), /#\/p\/[^/]+\/dashboard$/);
  await page.waitForSelector(".step");
  assert.match((await page.textContent("h2"))!, /Get set up · 1 of 9 done/);
  assert.equal(await page.locator(".step").count(), 8, "the domain step is already done");
  await page.locator(".step", { hasText: "Connect Analytics" }).locator('button:has-text("Hide")').click();
  await page.waitForFunction(() => document.querySelectorAll(".step").length === 7);
  assert.match((await page.textContent(".card p.muted"))!, /Hidden: Connect Analytics/);
  await page.click('button:has-text("Show again")');
  await page.waitForFunction(() => document.querySelectorAll(".step").length === 8);
  assert.equal(await page.locator("nav.tabs a.on").textContent(), "Dashboard");
});

test("prompt explorer: four answers side by side, brand highlighted, unsafe links never become links", async () => {
  await tab("AI visibility");
  await page.waitForSelector('textarea[name="prompt"]');
  await page.fill('textarea[name="prompt"]', "best crm for startups [brand]");
  await page.fill('input[name="brand"]', "Acme");
  await page.click('button:has-text("Ask")');
  await page.waitForSelector(".result .cols .card", { timeout: 15000 });
  assert.equal(await page.locator(".result .cols > .card").count(), 4);
  assert.match((await page.textContent(".result"))!, /was mentioned by 4 of 4 answers/);
  assert.equal(await page.locator(".result .pill:has-text('brand mentioned')").count(), 4);
  const hrefs = await page.locator(".result a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
  assert.ok(hrefs.length >= 8);
  assert.ok(hrefs.every((h) => /^https?:\/\//.test(h ?? "")), `only http(s) links: ${hrefs.join(",")}`);
  assert.ok((await page.locator(".result a").first().getAttribute("rel"))!.includes("noopener"));
  assert.match((await page.textContent(".result"))!, /cost \$0\.0480/);
  // asking again is served from the 7-day cache
  await page.click('button:has-text("Ask")');
  await page.waitForFunction(() => /cost \$0\.0000/.test(document.querySelector(".result")?.textContent ?? ""));
  assert.equal(await page.locator(".result .pill:has-text('cached')").count(), 4);
  await page.waitForSelector("text=Recent lookups");
});

test("one model that cannot take the chosen country is explained, the others still answer", async () => {
  await page.fill('textarea[name="prompt"]', "country check");
  await page.selectOption('select[name="country"]', "US");
  await page.locator('input[name="m"][value="gemini"]').check();
  await page.locator('input[name="m"][value="chat_gpt"]').uncheck();
  await page.locator('input[name="m"][value="perplexity"]').uncheck();
  await page.click('button:has-text("Ask")');
  await page.waitForSelector(".result .err", { timeout: 15000 });
  assert.match((await page.textContent(".result .err"))!, /Gemini doesn’t support country selection/);
});

test("brand lookup with a competitor: totals, share of voice, cited pages, questions", async () => {
  await page.click('button:has-text("Brand lookup")');
  await page.fill('input[name="competitors"]', "rival.com");
  await page.click('button:has-text("Look up")');
  await page.waitForSelector(".sov", { timeout: 15000 });
  const text = (await page.textContent(".result"))!;
  assert.match(text, /Mentions\s*140/);
  assert.match(text, /acme\.com67% · 140/);
  assert.match(text, /rival\.com33% · 70/);
  assert.match(text, /Most cited pages/);
  assert.match(text, /what is the best acme\.com\?/);
  assert.match(text, /cost \$0\.8000/);
  const hrefs = await page.locator(".result a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
  assert.ok(hrefs.every((h) => /^https?:\/\//.test(h ?? "")));
  // opening a saved lookup from the history shows the same result
  await page.locator("tr", { hasText: "rival" }).count();
  await page.locator('tr:has-text("Brand") button:has-text("Open")').first().click();
  await page.waitForSelector(".sov");
});

test("usage page: spend by feature, then a budget that blocks the next paid call with a clear message", async () => {
  await tab("Usage");
  await page.waitForSelector("text=By feature");
  assert.match((await page.textContent("main"))!, /AI visibility/);
  assert.match((await page.textContent("main"))!, /No limit set/);
  await page.fill('input[name="limit"]', "0.5");
  await page.click('button:has-text("Set limit")');
  await page.waitForSelector("text=used");
  assert.match((await page.textContent(".card p.critical"))!, /new paid calls are blocked/);
  await tab("AI visibility");
  await page.click('button:has-text("Prompt explorer")');
  await page.fill('textarea[name="prompt"]', "blocked by budget");
  await page.click('button:has-text("Ask")');
  await page.waitForSelector(".result .err", { timeout: 15000 });
  assert.match((await page.textContent(".result .err"))!, /monthly budget of \$0\.5000 is used up/);
  await tab("Usage");
  await page.waitForSelector('button:has-text("Remove limit")');
  await page.click('button:has-text("Remove limit")');
  await page.waitForSelector("text=No limit set");
  await page.click('a.navlink');
  await page.waitForSelector("h1:has-text('Usage & budget')");
  assert.match((await page.textContent("main"))!, /Acme/);
  assert.match((await page.textContent("main"))!, /Latest billed calls/);
});

test("dashboard now shows the work done: AI mentions, spend", async () => {
  await page.goto(`${base}/#/p/${pid}/dashboard`);
  await page.waitForSelector(".grid .stat");
  const text = (await page.textContent(".grid"))!;
  assert.match(text, /AI mentions\s*140/);
  assert.match(text, /Spent this month\s*\$/);
  assert.match((await page.textContent("main"))!, /acme\.com: 140 mentions/);
});

test("no script or console errors across the new pages (apart from the one 402 the budget test provokes on purpose)", () => {
  assert.deepEqual(errors.filter((e) => !/status of 402/.test(e)), []);
  assert.equal(errors.filter((e) => /status of 402/.test(e)).length, 1);
});
