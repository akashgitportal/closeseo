import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startFakeDfs, type FakeDfs } from "./support/fake-dataforseo.ts";
import { makeClient, makeCtx } from "./support/harness.ts";
import { AI_CALL_COST, AI_MENTIONS_COST } from "./support/fake-ai.ts";
import { detectTarget, extractCitations, pickLatestModel, shapeBrand, urlMatchesTarget } from "../src/services/aiVisibility.ts";
import { parseResearchTarget } from "../src/services/researchScope.ts";

const require = createRequire(import.meta.url);
const countries = require("../src/data/web-search-countries.json") as { all: string[]; claude: string[] };

let dfs: FakeDfs;
let c: ReturnType<typeof makeClient>;
let pid: string;
before(async () => { dfs = await startFakeDfs(); });
after(() => dfs.close());
beforeEach(async () => {
  dfs.reset();
  c = makeClient(makeCtx({ dfsUrl: dfs.url }));
  pid = (await c.tool("create_project", { name: "Acme", domain: "acme.com" })).structuredContent.project.id;
});

const ask = (body: unknown, project = pid) => c.post(`/api/projects/${project}/ai/prompt`, body);
const brand = (body: unknown, project = pid) => c.post(`/api/projects/${project}/ai/brand`, body);
const calls = (path: string) => (dfs.stats().byPath[path] ?? 0);
const LLM = (slug: string) => `/v3/ai_optimization/${slug}/llm_responses/live`;
const bodiesOf = (path: string) => (dfs.stats().bodies[path] ?? []) as any[];
let n = 0;
const uniq = (s: string) => `${s} #${++n}-${Math.random().toString(36).slice(2, 7)}`;

test("model choice follows the provider catalog: pinned ChatGPT model, newest Claude/Gemini/Perplexity", () => {
  assert.equal(pickLatestModel("chat_gpt", ["gpt-5.5", "gpt-5.6-luna", "gpt-4o"]), "gpt-5.6-luna");
  assert.equal(pickLatestModel("chat_gpt", ["gpt-5.5", "gpt-5.10", "gpt-5.9", "gpt-4o"]), "gpt-5.10");
  assert.equal(pickLatestModel("claude", ["claude-sonnet-4-5", "claude-sonnet-5", "claude-opus-9"]), "claude-sonnet-5");
  assert.equal(pickLatestModel("claude", ["claude-sonnet-4-6", "claude-sonnet-4-5"]), "claude-sonnet-4-6");
  assert.equal(pickLatestModel("gemini", ["gemini-2.0-flash"]), "gemini-2.5-pro", "falls back to the known list when nothing matches");
});

test("GET /api/ai/models lists the four providers with the model each will use", async () => {
  const r = (await (await c.get("/api/ai/models")).json()) as any;
  assert.deepEqual(r.models.map((m: any) => [m.model, m.modelName]), [["chat_gpt", "gpt-5.6-luna"], ["claude", "claude-sonnet-5"], ["gemini", "gemini-2.5-pro"], ["perplexity", "sonar-reasoning-pro"]]);
  assert.equal(r.webSearchCountries.gemini.length, 0);
  assert.equal(r.webSearchCountries.claude.length, countries.claude.length);
});

test("prompt explorer: one prompt across four models, citations cleaned, brand highlighted, request fields correct", async () => {
  const prompt = uniq("best crm [brand]");
  const res = await ask({ prompt, models: ["chat_gpt", "claude", "gemini", "perplexity"], highlightBrand: "acme" });
  assert.equal(res.status, 200);
  const out = (await res.json()) as any;
  assert.deepEqual(out.results.map((r: any) => r.model), ["chat_gpt", "claude", "gemini", "perplexity"]);
  const dup = (await (await ask({ prompt: uniq("dup"), models: ["claude", "claude"] })).json()) as any;
  assert.equal(dup.results.length, 1, "a repeated model is collapsed");
  assert.equal(calls(LLM("claude")), 2, "and is paid for once");
  const r = out.results[0];
  assert.equal(r.status, "success");
  assert.equal(r.text, "chat_gpt says: Acme is a solid choice. C++ fans like it.\n\nSecond paragraph.", "message sections joined, reasoning dropped");
  assert.deepEqual(r.citations.map((x: any) => x.url), ["https://www.acme.com/guide-chat_gpt", "https://reviews.example.org/best?x=1"], "duplicates, javascript: and credentialed URLs removed");
  assert.deepEqual(r.citations.map((x: any) => [x.domain, x.matchedBrand]), [["acme.com", true], ["reviews.example.org", false]]);
  assert.equal(r.brandMentioned, true);
  assert.equal(r.outputTokens, 321);
  assert.deepEqual(r.fanOutQueries, ["best tools", "acme pricing"]);
  assert.equal(r.modelName, "gpt-5.6-luna");
  assert.ok(Math.abs(out.costUsd - 4 * AI_CALL_COST) < 1e-9);
  const sent = Object.fromEntries(["chat_gpt", "claude", "gemini", "perplexity"].map((s) => [s, bodiesOf(LLM(s))[0]]));
  for (const b of Object.values(sent)) { assert.equal(b.max_output_tokens, 4096); assert.equal(b.web_search, true); assert.equal(b.user_prompt, prompt.trim()); assert.equal(b.web_search_country_iso_code, undefined); }
  assert.equal(sent.claude.force_web_search, true);
  assert.equal(sent.chat_gpt.force_web_search, undefined);
  assert.equal(sent.claude.model_name, "claude-sonnet-5");
});

test("prompt explorer: a brand that is not named is reported as not mentioned, and no brand means null", async () => {
  const prompt = uniq("plain question");
  const a = (await (await ask({ prompt, models: ["gemini"], highlightBrand: "Zebra Corp" })).json()) as any;
  assert.equal(a.results[0].brandMentioned, false);
  const b = (await (await ask({ prompt, models: ["gemini"] })).json()) as any;
  assert.equal(b.results[0].brandMentioned, null);
  assert.equal(b.results[0].cached, true);
  const cpp = (await (await ask({ prompt, models: ["gemini"], highlightBrand: "C++" })).json()) as any;
  assert.equal(cpp.results[0].brandMentioned, true, "brand that ends in a symbol still matches");
  const quiet = uniq("no links here");
  const full = (await (await ask({ prompt: quiet, models: ["gemini"], webSearch: false, highlightBrand: "Other" })).json()) as any;
  assert.equal(full.results[0].brandMentioned, true);
  const part = (await (await ask({ prompt: quiet, models: ["gemini"], webSearch: false, highlightBrand: "Othe" })).json()) as any;
  assert.equal(part.results[0].brandMentioned, false, "word boundaries: Othe is not Other");
});

test("prompt explorer: 7-day cache per project/model/prompt/search settings; a hit costs nothing", async () => {
  const prompt = uniq("cache me");
  const first = (await (await ask({ prompt, models: ["perplexity"] })).json()) as any;
  assert.equal(first.results[0].cached, false);
  assert.ok(first.costUsd > 0);
  const second = (await (await ask({ prompt: `  ${prompt.replace(" ", "   ")}  `, models: ["perplexity"], highlightBrand: "other" })).json()) as any;
  assert.equal(second.results[0].cached, true, "whitespace differences and a different brand reuse the entry");
  assert.equal(second.costUsd, 0);
  assert.equal(calls(LLM("perplexity")), 1);
  await ask({ prompt: prompt.toUpperCase(), models: ["perplexity"] });
  assert.equal(calls(LLM("perplexity")), 2, "casing is significant");
  await ask({ prompt, models: ["perplexity"], webSearch: false });
  assert.equal(calls(LLM("perplexity")), 3, "web search on/off are separate entries");
  const other = (await (await c.post("/api/projects", { name: "Other" })).json()) as any;
  await ask({ prompt, models: ["perplexity"] }, other.project.id);
  assert.equal(calls(LLM("perplexity")), 4, "another project does not share answers");
  assert.equal(bodiesOf(LLM("perplexity")).at(-2).web_search, false);
  assert.equal(bodiesOf(LLM("perplexity")).at(-2).force_web_search, undefined);
});

test("prompt explorer: one model failing does not hide the others; failures are not cached", async () => {
  const prompt = uniq("who wins [fail:claude]");
  const out = (await (await ask({ prompt, models: ["chat_gpt", "claude", "gemini"] })).json()) as any;
  assert.deepEqual(out.results.map((r: any) => r.status), ["success", "error", "success"]);
  assert.equal(out.results[1].errorCode, "UPSTREAM_ERROR");
  assert.equal(out.results[1].message, "This model could not be reached just now; try again shortly.", "provider detail is not leaked");
  await ask({ prompt, models: ["claude"] });
  assert.equal(calls(LLM("claude")), 2, "an error is retried next time instead of served from cache");
});

test("prompt explorer: an account billing problem is one clear error, not four model errors", async () => {
  const r = await ask({ prompt: uniq("[billing]"), models: ["chat_gpt", "gemini"] });
  assert.equal(r.status, 502);
  const e = ((await r.json()) as any).error;
  assert.equal(e.code, "UPSTREAM_BILLING");
  assert.match(e.message, /billing or balance problem/);
});

test("prompt explorer: retries once when a requested web search did not happen, keeps the first answer if the retry also skips it", async () => {
  const once = uniq("retry [nosearch-once]");
  const a = (await (await ask({ prompt: once, models: ["gemini"] })).json()) as any;
  assert.equal(calls(LLM("gemini")), 2);
  assert.equal(a.results[0].webSearch, true);
  assert.equal(a.results[0].citations.length, 2);
  assert.ok(Math.abs(a.costUsd - 2 * AI_CALL_COST) < 1e-9, "the retry is billed too");
  const never = uniq("skip [nosearch]");
  const b = (await (await ask({ prompt: never, models: ["gemini"] })).json()) as any;
  assert.equal(calls(LLM("gemini")), 4, "one retry, never more");
  assert.equal(b.results[0].webSearch, false);
  assert.deepEqual(b.results[0].citations, []);
  const off = uniq("no search wanted [nosearch]");
  await ask({ prompt: off, models: ["gemini"], webSearch: false });
  assert.equal(calls(LLM("gemini")), 5, "no retry when search was not requested");
});

test("prompt explorer: search country is forwarded only where supported", async () => {
  const notClaude = countries.all.find((x) => !countries.claude.includes(x))!;
  const prompt = uniq("country");
  const out = (await (await ask({ prompt, models: ["chat_gpt", "claude", "gemini"], webSearchCountryCode: notClaude })).json()) as any;
  assert.equal(out.results[0].status, "success");
  assert.equal(out.results[0].webSearchCountryCode, notClaude);
  assert.equal(bodiesOf(LLM("chat_gpt")).at(-1).web_search_country_iso_code, notClaude);
  for (const i of [1, 2]) { assert.equal(out.results[i].status, "error"); assert.equal(out.results[i].errorCode, "UNSUPPORTED_COUNTRY"); assert.match(out.results[i].message, /Any country/); }
  assert.equal(calls(LLM("claude")) + calls(LLM("gemini")), 0, "unsupported combinations are refused before any paid call");
  assert.match(out.results[2].message, /no country setting/);
  const noSearch = (await (await ask({ prompt: uniq("c2"), models: ["gemini"], webSearch: false, webSearchCountryCode: "US" })).json()) as any;
  assert.equal(noSearch.results[0].status, "success", "country is ignored when web search is off");
  const dflt = (await (await ask({ prompt: uniq("c3"), models: ["gemini"], webSearchCountryCode: "default" })).json()) as any;
  assert.equal(dflt.results[0].status, "success");
});

test("prompt explorer: input validation", async () => {
  const bad: [unknown, RegExp][] = [
    [{ models: ["gemini"] }, /Write a prompt/],
    [{ prompt: "   ", models: ["gemini"] }, /Write a prompt/],
    [{ prompt: "x".repeat(501), models: ["gemini"] }, /(too long|exceeds|above the)/],
    [{ prompt: "ok" }, /between one and four models/],
    [{ prompt: "ok", models: [] }, /between one and four models/],
    [{ prompt: "ok", models: ["gemini", "claude", "chat_gpt", "perplexity", "gemini", "x"] }, /between one and four models/],
    [{ prompt: "ok", models: ["llama"] }, /between one and four models/],
    [{ prompt: "ok", models: ["gemini"], webSearch: "yes" }, /true or false/],
    [{ prompt: "ok", models: ["gemini"], webSearchCountryCode: "usa" }, /country code/],
    [{ prompt: "ok", models: ["gemini"], highlightBrand: "b".repeat(251) }, /(too long|exceeds|above the)/],
    [{ prompt: "ok", models: ["gemini"], highlightBrand: 5 }, /has to be text/],
  ];
  for (const [body, re] of bad) {
    const r = await ask(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(((await r.json()) as any).error.message, re);
  }
  assert.equal(calls(LLM("gemini")), 0, "nothing is bought for invalid input");
  assert.equal((await ask({ prompt: "x".repeat(500), models: ["gemini"] })).status, 200, "exactly 500 characters is allowed");
  assert.equal((await ask({ prompt: "ok", models: ["gemini"] }, "nope")).status, 404);
  const bare = makeClient(makeCtx({ noKey: true }));
  const p = (await bare.tool("create_project", { name: "N" })).structuredContent.project.id;
  const r = await bare.post(`/api/projects/${p}/ai/prompt`, { prompt: "ok", models: ["gemini"] });
  assert.equal(r.status, 412);
  assert.match(((await r.json()) as any).error.message, /DATAFORSEO_API_KEY/);
});

test("citations: only plain http(s) links, no duplicates, at most 25", () => {
  const annotations = [...Array.from({ length: 40 }, (_, i) => ({ url: `https://s.example/${i}`, title: `t${i}` })), { url: "ftp://x.example/a" }, { url: "data:text/html,hi" }, { url: null }, { url: "" }];
  const out = extractCitations({ items: [{ type: "message", sections: [{ annotations }] }, { type: "reasoning", sections: [{ annotations: [{ url: "https://hidden.example" }] }] }] });
  assert.equal(out.length, 25);
  assert.equal(out[0]!.title, "t0");
  assert.ok(out.every((x) => x.url.startsWith("https://s.example/")));
});

// ---------------- brand lookup ----------------

const MENTION = "/v3/ai_optimization/llm_mentions";

test("target detection and URL scoping follow research-scope rules", () => {
  assert.deepEqual(detectTarget("  Acme.com "), { type: "domain", value: "acme.com" });
  assert.deepEqual(detectTarget("https://www.Acme.com/blog"), { type: "domain", value: "acme.com" });
  assert.deepEqual(detectTarget("Acme"), { type: "keyword", value: "Acme" });
  assert.deepEqual(detectTarget("best crm.tools"), { type: "keyword", value: "best crm.tools" });
  const sub = parseResearchTarget("acme.com/blog", "subfolder");
  assert.equal(urlMatchesTarget("https://www.acme.com/blog", sub), true);
  assert.equal(urlMatchesTarget("https://acme.com/blog/post/", sub), true);
  assert.equal(urlMatchesTarget("https://acme.com/blogging", sub), false);
  assert.equal(urlMatchesTarget("https://shop.acme.com/blog", sub), false);
  const exact = parseResearchTarget("acme.com/pricing/", "exact_url");
  assert.equal(urlMatchesTarget("https://acme.com/pricing", exact), true);
  assert.equal(urlMatchesTarget("https://acme.com/pricing/x", exact), false);
  assert.equal(urlMatchesTarget("https://shop.acme.com/x", parseResearchTarget("acme.com", "subdomains")), true);
  assert.equal(urlMatchesTarget("https://shop.acme.com/x", parseResearchTarget("acme.com", "domain")), false);
});

test("brand lookup (US/English): totals, share of voice, cited sources, top questions, trend; spend recorded", async () => {
  const res = await brand({ query: "https://www.Acme.com", competitors: ["rival.com", "ACME.com", "rival.com", "Other Brand"] });
  assert.equal(res.status, 200);
  const r = (await res.json()) as any;
  assert.equal(r.detectedTargetType, "domain");
  assert.equal(r.resolvedTarget, "acme.com");
  assert.deepEqual(r.perPlatform, [
    { platform: "chat_gpt", status: "success", mentions: 40, aiSearchVolume: 4000 },
    { platform: "google", status: "success", mentions: 100, aiSearchVolume: 10000 },
  ]);
  assert.equal(r.totalMentions, 140);
  assert.equal(r.totalAiSearchVolume, 14000);
  assert.equal(r.hasData, true);
  assert.deepEqual(r.shareOfVoice.platforms, ["chat_gpt", "google"]);
  assert.deepEqual(r.shareOfVoice.entries.map((e: any) => [e.label, e.isTarget, e.mentions]), [["acme.com", true, 140], ["rival.com", false, 70], ["Other Brand", false, null]]);
  assert.equal(Math.round(r.shareOfVoice.entries[0].sharePct), 67);
  assert.equal(r.shareOfVoice.entries[2].sharePct, null);
  // cited sources: unsafe link dropped, ordered by captured volume, with the questions that cited them
  assert.ok(r.topPages.every((p: any) => p.url.startsWith("https://")));
  assert.equal(r.topPages.length, 6);
  assert.equal(r.topPages[0].url, "https://www.acme.com/pricing");
  assert.deepEqual(r.topPages[0].keywords, [{ question: "what is the best acme.com?", aiSearchVolume: 4000 }]);
  // top questions: empty questions dropped, unsafe source links dropped, sorted by volume
  assert.deepEqual(r.topQueries.map((q: any) => [q.platform, q.question]).slice(0, 2), [["chat_gpt", "what is the best acme.com?"], ["google", "what is the best acme.com?"]]);
  assert.equal(r.topQueries.length, 4);
  assert.deepEqual(r.topQueries[0].citedSources.map((s: any) => s.url), ["https://www.acme.com/pricing"]);
  assert.deepEqual(r.topQueries[0].brandsMentioned, ["Acme", "Rival"]);
  // trend sums monthly volumes over both platforms; null volumes skipped
  assert.deepEqual(r.monthlyVolume, [{ year: 2026, month: 1, volume: 2000 }, { year: 2026, month: 2, volume: 4000 }]);
  // calls and cost: 2 platforms x 3 endpoints + 2 cross-aggregated
  assert.ok(Math.abs(r.costUsd - 8 * AI_MENTIONS_COST) < 1e-9);
  assert.equal(calls(`${MENTION}/cross_aggregated_metrics/live`), 2);
  const cross = bodiesOf(`${MENTION}/cross_aggregated_metrics/live`)[0];
  assert.deepEqual(cross.targets.map((t: any) => t.aggregation_key), ["acme.com", "rival.com", "Other Brand"]);
  assert.deepEqual(cross.targets[2].target[0], { keyword: "Other Brand", search_filter: "include", search_scope: ["any", "brand_entities"], match_type: "word_match" });
  assert.equal(cross.location_code, 2840);
  const agg = bodiesOf(`${MENTION}/aggregated_metrics/live`);
  assert.deepEqual(agg[0].target[0], { domain: "acme.com", include_subdomains: true, search_filter: "include", search_scope: ["any"] });
  assert.equal(agg[0].internal_list_limit, 20);
  const usage = (await (await c.get(`/api/usage?projectId=${pid}`)).json()) as any;
  assert.equal(usage.byFeature[0].feature, "ai_visibility");
  assert.ok(Math.abs(usage.totalUsd - 0.8) < 1e-9);
});

test("brand lookup: 24h cache, then served free; the saved history can reopen it", async () => {
  const body = { query: "cached-brand.com" };
  const first = (await (await brand(body)).json()) as any;
  assert.equal(first.cached, false);
  const before = dfs.stats().total;
  const second = (await (await brand({ query: "CACHED-brand.com " })).json()) as any;
  assert.equal(second.cached, true);
  assert.equal(second.costUsd, 0);
  assert.equal(dfs.stats().total, before, "no provider call on a hit");
  assert.equal(second.totalMentions, first.totalMentions);
  const runs = ((await (await c.get(`/api/projects/${pid}/ai/runs?kind=brand`)).json()) as any).runs;
  assert.equal(runs.length, 2);
  const one = (await (await c.get(`/api/projects/${pid}/ai/runs/${runs[0].id}`)).json()) as any;
  assert.equal(one.kind, "brand");
  assert.equal(one.result.totalMentions, 140);
  assert.equal((await c.app.request(`/api/projects/${pid}/ai/runs/${runs[0].id}`, { method: "DELETE" })).status, 204);
  assert.equal((await c.get(`/api/projects/${pid}/ai/runs/${runs[0].id}`)).status, 404);
  assert.equal((await c.get(`/api/projects/${pid}/ai/runs?kind=oops`)).status, 400);
});

test("brand lookup: a market other than US/English leaves ChatGPT out of totals, trend and share of voice", async () => {
  const uk = ((await (await c.post("/api/projects", { name: "UK", domain: "acme.com", locationCode: 2826 })).json()) as any).project.id;
  const r = (await (await brand({ query: "acme.com", competitors: ["rival.com"] }, uk)).json()) as any;
  assert.equal(r.perPlatform.find((p: any) => p.platform === "chat_gpt").mentions, 40, "still shown per platform");
  assert.equal(r.totalMentions, 100);
  assert.deepEqual(r.shareOfVoice.platforms, ["google"]);
  assert.deepEqual(r.monthlyVolume, [{ year: 2026, month: 1, volume: 1000 }, { year: 2026, month: 2, volume: 2000 }]);
  const google = bodiesOf(`${MENTION}/aggregated_metrics/live`);
  assert.deepEqual(google.map((b) => [b.platform, b.location_code, b.language_code]), [["chat_gpt", 2840, "en"], ["google", 2826, "en"]], "ChatGPT data is always US/English");
});

test("brand lookup: subfolder scope filters cited pages and questions and says the totals are domain-level", async () => {
  const r = (await (await brand({ query: "acme.com/blog", scope: "subfolder" })).json()) as any;
  assert.equal(r.scope, "subfolder");
  assert.equal(r.resolvedTarget, "acme.com/blog");
  assert.equal(r.aggregatesAreDomainLevel, true);
  assert.deepEqual([...new Set(r.topPages.map((p: any) => p.url))], ["https://www.acme.com/blog/guide"]);
  assert.deepEqual([...new Set(r.topQueries.map((q: any) => q.question))], ["is acme.com worth it"]);
  assert.equal(bodiesOf(`${MENTION}/aggregated_metrics/live`)[0].target[0].include_subdomains, false);
  assert.equal((await brand({ query: "acme.com", scope: "subfolder" })).status, 400, "a subfolder scope needs a path");
  assert.equal((await brand({ query: "Acme", scope: "bogus" })).status, 400);
});

test("brand lookup: keyword queries, empty results and partial failures", async () => {
  const kw = (await (await brand({ query: "Acme" })).json()) as any;
  assert.equal(kw.detectedTargetType, "keyword");
  assert.deepEqual(bodiesOf(`${MENTION}/search/live`)[0].target[0], { keyword: "Acme", search_filter: "include", search_scope: ["any", "brand_entities"], match_type: "word_match" });
  assert.equal(bodiesOf(`${MENTION}/search/live`)[0].limit, 100);

  const none = (await (await brand({ query: "nodata.example" })).json()) as any;
  assert.equal(none.hasData, false);
  assert.equal(none.totalMentions, null);
  const t0 = calls(`${MENTION}/search/live`);
  await brand({ query: "nodata.example" });
  assert.equal(calls(`${MENTION}/search/live`), t0 + 2, "an empty result is not cached");

  const partial = (await (await brand({ query: "partial.example" })).json()) as any;
  assert.equal(partial.perPlatform.every((p: any) => p.status === "success"), true);
  assert.deepEqual(partial.topPages, [], "the failed part is empty, the rest is kept");
  assert.ok(partial.topQueries.length > 0);
  const p0 = calls(`${MENTION}/search/live`);
  await brand({ query: "partial.example" });
  assert.equal(calls(`${MENTION}/search/live`), p0 + 2, "a partial result is not cached");
});

test("brand lookup: billing problem is a single error; validation and configuration", async () => {
  const r = await brand({ query: "billing.example" });
  assert.equal(r.status, 502);
  assert.equal(((await r.json()) as any).error.code, "UPSTREAM_BILLING");
  const bad: [unknown, RegExp][] = [
    [{}, /Type a brand/], [{ query: "  " }, /Type a brand/], [{ query: "x".repeat(251) }, /(too long|exceeds|above the)/],
    [{ query: "a", competitors: "b" }, /list of text/], [{ query: "a", competitors: ["a", "b", "c", "d", "e", "f"] }, /No more than 5/],
    [{ query: "a", competitors: ["z".repeat(251)] }, /competitor name exceeds/], [{ query: "a", locationCode: "US" }, /locationCode/], [{ query: "a", languageCode: "zz-nope" }, /language code/],
  ];
  const t = dfs.stats().total;
  for (const [body, re] of bad) { const x = await brand(body); assert.equal(x.status, 400, JSON.stringify(body)); assert.match(((await x.json()) as any).error.message, re); }
  assert.equal(dfs.stats().total, t, "nothing is bought for invalid input");
  assert.equal((await brand({ query: "a" }, "missing")).status, 404);
});

test("shapeBrand keeps only 12 months, caps lists and tolerates missing fields", () => {
  const months = Array.from({ length: 15 }, (_, i) => ({ year: 2025 + Math.floor(i / 12), month: (i % 12) + 1, search_volume: 10 }));
  const mentions = Array.from({ length: 30 }, (_, i) => ({ question: `q${i}`, ai_search_volume: i, monthly_searches: i === 0 ? months : null }));
  const r = shapeBrand({
    query: "x.com", detected: { type: "domain", value: "x.com" }, research: null, pageFilter: null, cross: [], competitorKeys: [], loc: 2840, lang: "en-US",
    bundles: [{ platform: "google", status: "success", bundle: { aggregated: {}, topPages: [{ key: null }, {}], mentions, complete: true } }, { platform: "chat_gpt", status: "error", bundle: null }],
  });
  assert.equal(r.monthlyVolume.length, 12);
  assert.deepEqual(r.monthlyVolume[0], { year: 2025, month: 4, volume: 10 });
  assert.equal(r.topQueries.length, 25);
  assert.equal(r.topQueries[0]!.question, "q29");
  assert.equal(r.totalMentions, null);
  assert.equal(r.shareOfVoice, null);
  assert.deepEqual(r.perPlatform[1], { platform: "chat_gpt", status: "error", mentions: null, aiSearchVolume: null });
});
