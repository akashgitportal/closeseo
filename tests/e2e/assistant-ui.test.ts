import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFakeOpenRouter, type FakeOpenRouter } from "../support/fake-openrouter.ts";
import { until } from "../support/harness.ts";

let or: FakeOpenRouter, proc: ChildProcess, browser: Browser, page: Page, base: string;
const dir = mkdtempSync(join(tmpdir(), "closeseo-chat-"));
const KEY = "sk-or-ui-test";
async function boot(withKey: boolean) {
  const port = 32000 + Math.floor(Math.random() * 7000);
  proc = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, `${port}.db`), DISABLE_SCHEDULER: "1", ...(withKey ? { OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: or.url } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; proc.stdout!.on("data", (d) => (out += d));
  await until(() => out.includes("listening"), 10000);
  return `http://127.0.0.1:${port}`;
}
before(async () => { or = await startFakeOpenRouter({ apiKey: KEY }); browser = await chromium.launch(); page = await browser.newPage(); page.on("dialog", (d) => void d.accept()); });
after(async () => { await browser?.close(); proc?.kill("SIGKILL"); await or.close(); rmSync(dir, { recursive: true, force: true }); });

async function openAssistant() {
  await page.goto(base); await page.fill('input[name="name"]', "Chat project"); await page.fill('input[name="domain"]', "example.com");
  await page.click('button:has-text("Create")'); await page.waitForSelector("nav.tabs");
  await page.locator("nav.tabs a", { hasText: "Assistant" }).click();
}

test("without a key the Assistant tab explains how to turn it on", async () => {
  base = await boot(false); await openAssistant();
  await page.waitForSelector("h2:has-text('The assistant is off')");
  assert.match((await page.textContent("main"))!, /OPENROUTER_API_KEY/);
  proc.kill("SIGKILL");
});

test("chat in a real browser: send a message, see a tool chip and a rendered answer; markup from the model is never executed", async () => {
  base = await boot(true); await openAssistant();
  await page.waitForSelector("#chat-input");
  or.script(
    { tools: [{ name: "save_keywords", args: { keywords: ["blue widgets"] } }] },
    { text: "## Saved\n**1 keyword** saved.\n\n| keyword | volume |\n|---|---|\n| blue widgets | 100 |\n\n- next step one\n- see [docs](https://example.com/docs)\n\n<img src=x onerror=\"window.__xss=1\"> <script>window.__xss=2</script> [bad](javascript:alert(1))" });
  await page.fill("#chat-input", "save blue widgets"); await page.click("#chat-send");
  await page.waitForSelector(".bubble.assistant h3:has-text('Saved')");
  assert.equal(await page.locator(".bubble.user").first().textContent(), "save blue widgets");
  assert.equal(await page.locator(".bubble.assistant table td:has-text('blue widgets')").count(), 1);
  assert.equal(await page.locator(".bubble.assistant strong").first().textContent(), "1 keyword");
  assert.equal(await page.locator('.bubble.assistant a[href="https://example.com/docs"]').getAttribute("rel"), "noopener noreferrer");
  assert.ok((await page.locator(".bubble .chips .pill", { hasText: "save_keywords" }).count()) >= 1, "tool chip shown");
  assert.equal(await page.locator(".bubble.assistant img, .bubble.assistant script").count(), 0, "no HTML from the model is rendered");
  assert.equal(await page.locator('a[href^="javascript"]').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).__xss), undefined);
  assert.match((await page.textContent("main"))!, /this chat has cost \$0\.0008/);
  // the tool really ran: the keyword is saved
  await page.locator("nav.tabs a", { hasText: "Saved" }).click();
  await page.waitForFunction(() => /blue widgets/.test(document.body.textContent ?? ""));
});

test("errors from the provider show inside the chat instead of breaking the page; chats persist and can be deleted", async () => {
  await page.locator("nav.tabs a", { hasText: "Assistant" }).click(); await page.waitForSelector("#chat-input");
  or.script({ http: 402 });
  await page.fill("#chat-input", "another question"); await page.click("#chat-send");
  await page.waitForSelector(".bubble.err:has-text('no credit left')");
  assert.equal(await page.isEnabled("#chat-send"), true, "the form is usable again");
  await page.reload(); await page.waitForSelector("#chat-input");
  assert.ok((await page.locator(".bubble.user").count()) >= 1, "the earlier chat is still there after a reload");
  await page.locator('button:has-text("Delete chat")').click();
  await page.waitForSelector(".empty:has-text('Start a chat')");
});
