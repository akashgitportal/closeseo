import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFakeGoogle, type FakeGoogle } from "../support/fake-google.ts";
import { until } from "../support/harness.ts";

let g: FakeGoogle, proc: ChildProcess, browser: Browser, page: Page, base: string;
const dir = mkdtempSync(join(tmpdir(), "closeseo-gui-"));
before(async () => {
  g = await startFakeGoogle({ clientId: "cid", clientSecret: "csec" });
  const port = 31000 + Math.floor(Math.random() * 8000);
  base = `http://localhost:${port}`;
  proc = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, "g.db"), DISABLE_SCHEDULER: "1", PUBLIC_URL: base, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", CLOSESEO_SECRET: "k".repeat(40), GOOGLE_API_ORIGIN: g.origin, GOOGLE_TOKEN_URL: `${g.origin}/token`, GOOGLE_AUTH_URL: `${g.origin}/auth` }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; proc.stdout!.on("data", (d) => (out += d));
  await until(() => out.includes("listening"), 10000);
  browser = await chromium.launch(); page = await browser.newPage();
  page.on("dialog", (d) => void d.accept());
});
after(async () => { await browser?.close(); proc?.kill("SIGKILL"); await g.close(); rmSync(dir, { recursive: true, force: true }); });

test("full Google flow in a real browser: connect Search Console, pick a property, see queries; connect Analytics and pick a property", async () => {
  await page.goto(base);
  await page.fill('input[name="name"]', "Google test"); await page.fill('input[name="domain"]', "example.com");
  await page.click('button:has-text("Create")');
  await page.waitForSelector("nav.tabs");
  await page.locator("nav.tabs a", { hasText: "Integrations" }).click();
  await page.waitForSelector("h2:has-text('Google Search Console')");
  assert.equal(await page.locator('button:has-text("Connect a Google account")').count(), 2);
  await page.locator('button:has-text("Connect a Google account")').first().click();      // -> fake consent -> back to closeseo
  await page.waitForSelector("text=Google account connected");
  assert.match(page.url(), /#\/p\/[0-9a-f-]+\/integrations$/);
  assert.ok(!page.url().includes("google=connected"), "the one-shot flash parameters are removed from the address bar");
  await page.locator("td", { hasText: "sc-domain:example.com" }).locator("xpath=..").locator("button:has-text('Use this')").click();
  await page.waitForSelector("text=Using sc-domain:example.com");
  await page.waitForSelector("h2:has-text('Top queries')");
  assert.match((await page.textContent("main"))!, /query 0/);
  assert.match((await page.textContent("main"))!, /owner@example\.com/);
  // Analytics
  await page.locator("h2:has-text('Google Analytics 4')").locator("xpath=..").locator('button:has-text("Connect a Google account")').click();
  await page.waitForSelector("td:has-text('Acme Web')");
  await page.locator("td", { hasText: "Acme Web" }).locator("xpath=..").locator("button:has-text('Use this')").click();
  await page.waitForSelector("text=Using Acme Web (properties/111)");
  // disconnect Search Console
  await page.locator("h2:has-text('Google Search Console')").locator("xpath=..").locator('button:has-text("Disconnect")').click();
  await page.waitForFunction(() => /Not connected to this project/.test(document.body.textContent ?? ""));
});

test("declining on Google's screen returns to the page with a clear message and nothing connected", async () => {
  await g.control({ deny: true });
  await page.locator('button:has-text("Connect a Google account")').first().click();
  await page.waitForSelector("text=Google sign-in did not finish: access_denied");
  await g.control({ deny: false });
});
