import { fakeAi } from "./fake-ai.ts";
import { fakeLocal, localControl, rememberTask } from "./fake-local.ts";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";

/**
 * Deterministic stand-in for the DataForSEO v3 API, used by both closeseo's tests
 * and the SOURCE-vs-NEW differential runs. Same request -> same response.
 *
 * Control endpoints (no auth):
 *   POST /__control  {"mode":"ok"|"http503"|"http401"|"balance"|"invalid_field"|"badjson"|"slow", "ms":number}
 *   GET  /__stats    -> {total, byPath, last: [...]}
 */
export type FakeDfs = {
  url: string;
  port: number;
  close(): Promise<void>;
  stats(): { total: number; byPath: Record<string, number>; bodies: Record<string, unknown[]> };
  setMode(mode: string, ms?: number): void;
  reset(): void;
};

const h = (s: string) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 8), 16);
const SUFFIXES = ["best", "tools", "software", "free", "online", "for beginners", "guide", "pricing", "vs", "alternatives", "near me", "reviews", "examples", "template", "course"];

function kwInfo(keyword: string, withTrends = false) {
  const n = h(keyword);
  return {
    keyword,
    keyword_info: {
      search_volume: (n % 50) * 100 + 10,
      cpc: Math.round(((n % 400) / 100) * 100) / 100,
      competition: Math.round(((n % 100) / 100) * 100) / 100,
      monthly_searches: withTrends ? Array.from({ length: 12 }, (_, i) => ({ year: 2026, month: i + 1, search_volume: ((n >>> i) % 50) * 100 + 10 })) : null,
    },
    keyword_properties: { keyword_difficulty: n % 100 },
    search_intent_info: { main_intent: ["informational", "commercial", "transactional", "navigational"][n % 4] },
    clickstream_keyword_info: { search_volume: (n % 30) * 90 },
  };
}

const ok = (result: unknown, cost = 0.01) => ({
  status_code: 20000, status_message: "Ok.", cost,
  tasks: [{ status_code: 20000, status_message: "Ok.", cost, result_count: Array.isArray(result) ? result.length : 1, result: Array.isArray(result) ? result : [result] }],
});

function serpFor(keyword: string, depth: number) {
  const n = h(keyword);
  const items: unknown[] = [];
  const hosts = ["wikipedia.org", "example.com", "competitor-a.com", "competitor-b.net", "blog.example.org", "news-site.com", "forum.example.io", "shop.example.shop", "docs.example.dev", "other.example.co"];
  const unranked = keyword.includes("unranked");
  const ex = unranked ? 999 : (n % 20) + 1;
  for (let i = 1; i <= depth; i++) {
    let host = hosts[(i + n) % hosts.length]!;
    if (i === ex) host = "www.example.com";
    else if (host === "example.com" || host === "www.example.com") host = "filler-" + i + ".com";
    items.push({
      type: "organic", rank_group: i, rank_absolute: i, domain: host,
      title: `${keyword} — result ${i}`, url: `https://${host}/${encodeURIComponent(keyword.replace(/ /g, "-"))}`, description: `Result ${i} about ${keyword}`,
    });
  }
  // A SERP feature sits between organic #2 and #3, so every later rank_absolute is one higher than its rank_group.
  items.splice(2, 0, { type: "people_also_ask", rank_group: 1, rank_absolute: 3, items: [] });
  for (const it of items as { type: string; rank_absolute: number }[]) if (it.type === "organic" && it.rank_absolute >= 3) it.rank_absolute += 1;
  return items;
}

export async function startFakeDfs(opts: { port?: number; login?: string; password?: string } = {}): Promise<FakeDfs> {
  const expected = "Basic " + Buffer.from(`${opts.login ?? "fake"}:${opts.password ?? "fake"}`).toString("base64");
  let mode = "ok";
  let slowMs = 0;
  let pausePaths: string[] = []; // these endpoints always answer "paused" (unbilled)
  let pauseNext = 0; // next N paid calls answer "access temporarily paused" (task code 40201), unbilled
  let taskMode = "ok"; // ok | never_ready | fail_tasks | reject_post
  let taskReadyMs = 20;
  const tasks = new Map<string, { createdAt: number; items: unknown[]; keyword: string; payload: Record<string, any> }>();
  let total = 0;
  let byPath: Record<string, number> = {};
  let bodies: Record<string, unknown[]> = {};

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const send = (status: number, body: unknown) => {
      // Real DataForSEO tasks always carry the endpoint path as an array (billing metadata).
      const task = (body as { tasks?: Record<string, unknown>[] } | null)?.tasks?.[0];
      if (task && typeof body === "object" && task.path === undefined) task.path = path.split("/").filter(Boolean);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (path === "/__control") {
      const b = JSON.parse(raw || "{}") as { mode?: string; ms?: number; taskMode?: string; taskReadyMs?: number; pauseNext?: number; pausePaths?: string[] };
      if (b.pauseNext !== undefined) pauseNext = b.pauseNext;
      if (b.pausePaths !== undefined) pausePaths = b.pausePaths;
      if (b.taskMode !== undefined) taskMode = b.taskMode;
      if (b.taskReadyMs !== undefined) taskReadyMs = b.taskReadyMs;
      localControl({ taskReadyMs: b.taskReadyMs, neverReady: b.taskMode === "never_ready" ? true : b.taskMode === "ok" ? false : undefined });
      if (b.mode !== undefined || b.ms !== undefined) { mode = b.mode ?? "ok"; slowMs = b.ms ?? 0; }
      return send(200, { mode, taskMode });
    }
    if (path === "/__stats") return send(200, { total, byPath });
    total++;
    byPath[path] = (byPath[path] ?? 0) + 1;
    if (req.headers.authorization !== expected) return send(401, { status_code: 40101, status_message: "Authentication failed." });
    if (pausePaths.includes(path) || pauseNext > 0 && path.startsWith("/v3/") && !path.startsWith("/v3/serp/google/locations") && path !== "/v3/appendix/user_data") {
      if (!pausePaths.includes(path)) pauseNext--;
      return send(200, { status_code: 20000, status_message: "Ok.", cost: 0, tasks: [{ status_code: 40201, status_message: "We noticed some unusual activity in your DataForSEO account, so we’ve temporarily paused access as a precaution. Please, reach out to our support team at support@dataforseo.com for more details, and we’ll work with you to resolve this quickly.", cost: 0, result: null }] });
    }
    if (mode === "http503") return send(503, { status_code: 50000, status_message: "Down" });
    if (mode === "http401") return send(401, { status_code: 40101, status_message: "Authentication failed." });
    if (mode === "badjson") return send(200, "<html>not json");
    if (mode === "balance") return send(200, { status_code: 20000, tasks: [{ status_code: 40200, status_message: "Payment Required. Not enough funds." }] });
    if (mode === "invalid_field") return send(200, { status_code: 20000, tasks: [{ status_code: 40501, status_message: "Invalid Field: 'keyword'." }] });
    if (mode === "slow") await new Promise((r) => setTimeout(r, slowMs));

    let body: Record<string, any> = {};
    let all: Record<string, any>[] = [];
    try { const p = JSON.parse(raw || "[]"); all = Array.isArray(p) ? p : [p]; body = all[0] ?? {}; } catch { return send(400, { status_code: 40000, status_message: "Bad JSON" }); }
    for (const b of all.length ? all : [{}]) (bodies[path] ??= []).push(b);

    if (path === "/v3/serp/google/organic/task_post") {
      const out = all.map((t, idx) => {
        if (taskMode === "reject_post") return { status_code: 40501, status_message: "Invalid Field: 'keyword'.", cost: 0 };
        const id = `task-${Date.now()}-${tasks.size}-${idx}`;
        const depth = Number(t.depth ?? 10);
        tasks.set(id, { createdAt: Date.now(), items: serpFor(String(t.keyword ?? ""), depth), keyword: String(t.keyword ?? ""), payload: t });
        return { id, status_code: 20100, status_message: "Task Created.", cost: 0.0006 + (Math.ceil(depth / 10) - 1) * 0.00045, result_count: 0, path: ["v3", "serp", "google", "organic", "task_post"], result: null };
      });
      return send(200, { status_code: 20000, status_message: "Ok.", cost: 0, tasks_count: out.length, tasks: out });
    }
    if (path.startsWith("/v3/serp/google/organic/task_get/advanced/")) {
      const id = decodeURIComponent(path.split("/").pop()!);
      const t = tasks.get(id);
      if (!t) return send(200, { status_code: 20000, tasks: [{ id, status_code: 40401, status_message: "Not Found.", result: null }] });
      if (taskMode === "fail_tasks") return send(200, { status_code: 20000, tasks: [{ id, status_code: 40501, status_message: "Invalid Field: 'keyword'.", result: null }] });
      if (taskMode === "never_ready" || Date.now() - t.createdAt < taskReadyMs) return send(200, { status_code: 20000, tasks: [{ id, status_code: 40602, status_message: "Task In Queue.", result: null }] });
      const dev = t.payload.device === "mobile";
      const items = serpFor(t.keyword, Number(t.payload.depth ?? 10)) as any[];
      if (dev) { const i = items.findIndex((x) => x.domain === "www.example.com"); if (i >= 0 && i + 1 < items.length) { const a = items[i], b = items[i + 1]; [a.domain, b.domain] = [b.domain, a.domain]; [a.url, b.url] = [b.url, a.url]; } }
      return send(200, ok({ keyword: t.keyword, items_count: items.length, items }, 0.0006));
    }

    const loc = body.location_code as number | undefined;
    const noLabs = loc === 2352;

    if (path.startsWith("/v3/serp/google/locations/")) {
      const iso = path.split("/").pop()!;
      return send(200, ok([
        { location_code: 2840, location_name: "United States", location_type: "Country", country_iso_code: iso },
        { location_code: 1023191, location_name: "New York,New York,United States", location_type: "City", country_iso_code: iso },
        { location_code: 1014221, location_name: "Los Angeles,California,United States", location_type: "City", country_iso_code: iso },
        { location_code: 21137, location_name: "Texas,United States", location_type: "State", country_iso_code: iso },
      ]));
    }
    const local = fakeLocal(path, body, req.method ?? "POST");
    if (local) {
      if (local.error) return send(200, { status_code: 20000, status_message: "Ok.", cost: 0, tasks: [{ status_code: local.error.code, status_message: local.error.message, cost: 0, result: null }] });
      if (local.raw) {
        const out = all.map((t, idx) => { const id = `bd-${Date.now()}-${tasks.size}-${idx}`; rememberTask(String(local.result), id, t); tasks.set(id, { createdAt: Date.now(), items: [], keyword: String(t.keyword ?? ""), payload: t }); return { id, status_code: 20100, status_message: "Task Created.", cost: 0.0015, result_count: 0, result: null }; });
        return send(200, { status_code: 20000, status_message: "Ok.", cost: 0, tasks_count: out.length, tasks: out });
      }
      return send(200, ok(Array.isArray(local.result) ? local.result : [local.result], local.cost));
    }
    const ai = fakeAi(path, body);
    if (ai) {
      if (ai.error) return send(200, { status_code: 20000, status_message: "Ok.", cost: 0, tasks: [{ status_code: ai.error.code, status_message: ai.error.message, cost: 0, result: null }] });
      return send(200, ok([ai.result], ai.cost));
    }
    switch (path) {
      case "/v3/dataforseo_labs/google/keyword_suggestions/live": {
        const seed = String(body.keyword ?? "");
        if (noLabs || seed.includes("nodata")) return send(200, ok({ seed_keyword: seed, total_count: 0, items_count: 0, items: null }));
        const lim = Math.min(Number(body.limit ?? 100), SUFFIXES.length * 2 + 1);
        const kws = [seed, ...SUFFIXES.flatMap((s) => [`${seed} ${s}`, `${s} ${seed}`])].slice(0, lim);
        return send(200, ok({ seed_keyword: seed, total_count: kws.length, items_count: kws.length, items: kws.map((k) => kwInfo(k)) }));
      }

      case "/v3/dataforseo_labs/google/keyword_ideas/live": {
        const seeds = (body.keywords as string[]) ?? [];
        const seed = seeds[0] ?? "";
        if (noLabs || seed.includes("nodata")) return send(200, ok({ seed_keywords: seeds, total_count: 0, items_count: 0, items: null }));
        const lim = Math.min(Number(body.limit ?? 100), SUFFIXES.length * 2 + 1);
        const kws = [seed, ...SUFFIXES.flatMap((s) => [`${seed} ${s}`, `${s} ${seed}`])].slice(0, lim);
        return send(200, ok({ seed_keywords: seeds, total_count: kws.length, items_count: kws.length, items: kws.map((k) => kwInfo(k)) }));
      }
      case "/v3/dataforseo_labs/google/related_keywords/live": {
        const seed = String(body.keyword ?? "");
        if (noLabs || seed.includes("nodata")) return send(200, ok({ seed_keyword: seed, total_count: 0, items_count: 0, items: null }));
        const kws = SUFFIXES.slice(0, 8).map((s) => `${seed} ${s}`);
        return send(200, ok({ seed_keyword: seed, total_count: kws.length, items_count: kws.length, items: kws.map((k) => ({ keyword_data: kwInfo(k), depth: 1, related_keywords: [] })) }));
      }
      case "/v3/keywords_data/google_ads/search_volume/live": {
        const kws = (body.keywords as string[]) ?? [];
        return send(200, ok(kws.map((k) => ({ keyword: k, search_volume: (h(k) % 50) * 100 + 10, cpc: Math.round(((h(k) % 400) / 100) * 100) / 100, competition: "LOW", competition_index: h(k) % 100, monthly_searches: Array.from({ length: 12 }, (_, i) => ({ year: 2026, month: i + 1, search_volume: (((h(k) >>> i) % 50)) * 100 + 10 })) }))));
      }
      case "/v3/dataforseo_labs/google/relevant_pages/live":
        return send(200, ok({ total_count: 0, items_count: 0, items: [] }));
      case "/v3/backlinks/referring_domains/live": {
        const t = String(body.target ?? "");
        const items = Array.from({ length: 12 }, (_, i) => ({ type: "referring_domain", domain: `ref${i}.org`, rank: 700 - i * 30, backlinks: 50 - i, first_seen: "2026-01-01 00:00:00 +00:00", referring_domains: 10 + i, backlinks_spam_score: i % 20 }));
        return send(200, ok({ target: t, total_count: items.length, items_count: items.length, items }));
      }
      case "/v3/backlinks/history/live":
        return send(200, ok({ target: String(body.target ?? ""), items: [{ date: "2026-08-01", backlinks: 100, referring_domains: 10 }, { date: "2026-09-01", backlinks: 120, referring_domains: 12 }] }));
      case "/v3/backlinks/domain_pages_summary/live":
        return send(200, ok({ target: String(body.target ?? ""), total_count: 0, items_count: 0, items: [] }));
      case "/v3/keywords_data/google_ads/keywords_for_keywords/live": {
        const seed = String((body.keywords as string[])?.[0] ?? "");
        return send(200, ok(SUFFIXES.slice(0, 8).map((s) => ({ keyword: `${seed} ${s}`, search_volume: (h(seed + s) % 40) * 50, cpc: 1.25, competition_index: h(s) % 100, competition: "LOW" }))));
      }
      case "/v3/dataforseo_labs/google/keyword_overview/live": {
        const kws = (body.keywords as string[]) ?? [];
        return send(200, ok({ items_count: kws.length, items: kws.map((k) => kwInfo(k, true)) }));
      }
      case "/v3/dataforseo_labs/google/ranked_keywords/live": {
        const target = String(body.target ?? "");
        const all = Array.from({ length: 37 }, (_, i) => {
          const k = `${target.split(".")[0]} topic ${i + 1}`;
          const info = kwInfo(k);
          return {
            keyword_data: { keyword: k, keyword_info: info.keyword_info, keyword_properties: info.keyword_properties },
            ranked_serp_element: { serp_item: { type: "organic", rank_group: (i % 20) + 1, rank_absolute: (i % 20) + 1, url: `https://${target}/page-${i + 1}`, etv: (37 - i) * 3.5 } },
          };
        });
        const off = Number(body.offset ?? 0), lim = Number(body.limit ?? 100);
        return send(200, ok({ total_count: all.length, items_count: Math.min(lim, Math.max(0, all.length - off)), items: all.slice(off, off + lim) }));
      }
      case "/v3/dataforseo_labs/google/domain_rank_overview/live": {
        const target = String(body.target ?? "");
        if (noLabs) return send(200, ok({ total_count: 0, items: null }));
        return send(200, ok({ total_count: 1, items: [{ se_type: "google", location_code: loc, language_code: body.language_code, metrics: { organic: { pos_1: 5, count: (h(target) % 5000) + 10, etv: (h(target) % 90000) + 100 } } }] }));
      }
      case "/v3/dataforseo_labs/google/serp_competitors/live": {
        const items = ["competitor-a.com", "competitor-b.net", "wikipedia.org", "example.com"].map((d, i) => ({ domain: d, avg_position: 3 + i, median_position: 3 + i, rating: 100 - i * 10, etv: 5000 - i * 900, keywords_count: 40 - i * 7, visibility: 0.9 - i * 0.2 }));
        return send(200, ok({ items_count: items.length, items }));
      }
      case "/v3/backlinks/summary/live": {
        const t = String(body.target ?? "");
        return send(200, ok({ target: t, rank: h(t) % 1000, backlinks: (h(t) % 100000) + 5, referring_domains: (h(t) % 3000) + 2, referring_main_domains: (h(t) % 2500) + 1, referring_ips: (h(t) % 2000) + 1, broken_backlinks: h(t) % 50, backlinks_spam_score: h(t) % 30, referring_links_attributes: { nofollow: 100, dofollow: 900 } }));
      }
      case "/v3/backlinks/backlinks/live": {
        const t = String(body.target ?? "");
        const off = Number(body.offset ?? 0), lim = Number(body.limit ?? 100);
        const all = Array.from({ length: 23 }, (_, i) => ({ type: "backlink", domain_from: `site${i}.org`, url_from: `https://site${i}.org/post-${i}`, url_to: `https://${t}/`, anchor: `anchor ${i}`, dofollow: i % 3 !== 0, rank: 900 - i * 20, domain_from_rank: 800 - i * 15, backlink_spam_score: i % 40, first_seen: "2026-01-15 00:00:00 +00:00", last_seen: "2026-09-01 00:00:00 +00:00", is_lost: false, is_broken: false }));
        return send(200, ok({ target: t, total_count: all.length, items_count: Math.min(lim, Math.max(0, all.length - off)), items: all.slice(off, off + lim) }));
      }
      case "/v3/serp/google/organic/live/advanced": {
        const kw = String(body.keyword ?? "");
        const depth = Number(body.depth ?? 10);
        const dev = body.device === "mobile" ? 1 : 0;
        const items = serpFor(kw + (dev ? "" : ""), depth);
        // mobile shifts the tracked domain by one rank so device columns differ deterministically
        if (dev) { const i = items.findIndex((x: any) => x.domain === "www.example.com"); if (i >= 0 && i + 1 < items.length) { const a: any = items[i], b: any = items[i + 1]; [a.domain, b.domain] = [b.domain, a.domain]; [a.url, b.url] = [b.url, a.url]; } }
        return send(200, ok({ keyword: kw, type: "organic", se_domain: "google.com", location_code: loc, language_code: body.language_code, check_url: "https://google.com", items_count: items.length, items }, 0.002 * Math.ceil(depth / 10)));
      }
      case "/v3/on_page/lighthouse/live/json":
        return send(200, ok({ categories: { performance: { score: 0.91 }, accessibility: { score: 0.95 }, "best-practices": { score: 1 }, seo: { score: 0.98 } } }, 0.00425));
    }
    return send(404, { status_code: 40400, status_message: "Not Found." });
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, port,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
    stats: () => ({ total, byPath: { ...byPath }, bodies }),
    setMode(m, ms = 0) { mode = m; slowMs = ms; },
    reset() { total = 0; byPath = {}; bodies = {}; mode = "ok"; slowMs = 0; pauseNext = 0; pausePaths = []; },
  };
}
