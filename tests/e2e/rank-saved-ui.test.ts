import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFakeDfs, type FakeDfs } from "../support/fake-dataforseo.ts";
import { FAKE_KEY, until } from "../support/harness.ts";

let dfs: FakeDfs, proc: ChildProcess, browser: Browser, page: Page, base: string, pid: string, tid: string;
const dir = mkdtempSync(join(tmpdir(), "closeseo-rank-ui-"));
const errors: string[] = [];
const api = async (path: string, body?: unknown, method = body ? "POST" : "GET") => (await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
const tool = async (name: string, args: object) => (await api(`/api/tools/${name}`, args)).data;

before(async () => {
  dfs = await startFakeDfs();
  const port = 30000 + Math.floor(Math.random() * 9000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, "ui.db"), DATAFORSEO_API_KEY: FAKE_KEY, DATAFORSEO_BASE_URL: dfs.url, DISABLE_SCHEDULER: "1", RANK_POLL_MS: "25" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; proc.stdout!.on("data", (d) => (out += d));
  await until(() => out.includes("listening"), 10000);
  pid = (await api("/api/projects", { name: "Acme", domain: "example.com" })).project.id;
  await tool("save_keywords", { projectId: pid, keywords: ["blue widget", "red widget", "green gadget"], tags: ["widgets"] });
  await tool("save_keywords", { projectId: pid, keywords: ["yellow gadget"], tags: ["gadgets"] });
  tid = (await tool("create_rank_tracker", { projectId: pid, devices: "both" })).config.id;
  await tool("add_rank_tracking_keywords", { projectId: pid, trackerId: tid, keywords: ["alpha", "beta"] });
  await tool("run_rank_tracker", { projectId: pid, trackerId: tid, maxCostCredits: 100000 });
  await until(async () => (await tool("get_rank_tracker", { projectId: pid, trackerId: tid })).results.run?.status === "completed", 8000);
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => void d.accept());
});
after(async () => { await browser?.close(); proc?.kill("SIGKILL"); await dfs.close(); rmSync(dir, { recursive: true, force: true }); });

test("saved keywords: filter by text and by tag, and choose how many rows", async () => {
  await page.goto(`${base}/#/p/${pid}/saved`);
  await page.waitForFunction(() => /4 saved/.test(document.querySelector("p.muted")?.textContent ?? ""));
  assert.equal(await page.locator("tbody tr").count(), 4);
  await page.fill('input[placeholder="keyword contains…"]', "widget");
  await page.press('input[placeholder="keyword contains…"]', "Tab");
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 2);
  assert.match((await page.textContent("p.muted"))!, /^2 saved/);
  await page.selectOption("select >> nth=0", "widgets");
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 2);
  await page.fill('input[placeholder="keyword contains…"]', "gadget");
  await page.press('input[placeholder="keyword contains…"]', "Tab");
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1);
  assert.match((await page.textContent("tbody"))!, /green gadget/, "text AND tag");
});

test("rank tracker: keyword history, visibility trend, edit settings, archive", async () => {
  await page.goto(`${base}/#/p/${pid}/rank/${tid}`);
  await page.waitForSelector("text=Visibility over time");
  assert.match((await page.textContent("main"))!, /Top 3.*4–10.*11–20.*Not ranking/);
  await page.locator("a", { hasText: "alpha" }).first().click();
  await page.waitForSelector("text=History: alpha");
  assert.equal(await page.locator("h3", { hasText: /^(desktop|mobile)$/ }).count() >= 2, true);
  await page.selectOption('select[name="devices"]', "desktop");
  await page.selectOption('select[name="interval"]', "weekly");
  await page.click('button:has-text("Save settings")');
  await page.waitForFunction(() => /desktop · top 40 · weekly/.test(document.querySelector("h2")?.textContent ?? ""));
  await page.click('button:has-text("Archive tracker")');
  await page.waitForSelector("text=New tracker");
  assert.equal(await page.locator("tbody tr").count(), 0, "an archived tracker is gone from the list");
  assert.deepEqual(errors, []);
});
