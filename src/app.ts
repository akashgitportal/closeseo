import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Ctx } from "./ctx.ts";
import { AppError } from "./errors.ts";
import { handleRpc } from "./mcp/server.ts";
import { HANDLERS } from "./mcp/tools.ts";
import { createProject, deleteProject, getProject, listProjects, updateProject } from "./services/projects.ts";
import { cancelAudit } from "./services/audit.ts";
import { getRankConfigTrend, getRankKeywordHistory, getRankPositionMatrix, updateRankTracker } from "./services/rankTracking.ts";
import { attachUsage, getUsage, listBudgets, setBudget } from "./services/usage.ts";
import { brandLookup, deleteRun, explorePrompt, getRun, listModels, listRuns, webSearchCountries } from "./services/aiVisibility.ts";
import { dismissStep, getDashboard } from "./services/dashboard.ts";
import { getSharedReport } from "./services/reports.ts";
import { createSession, deleteSession, getTranscript, listSessions, runTurn } from "./agent/agent.ts";
import { PROVIDERS, abandonAuthorization, completeAuthorization, googleConfigured, startAuthorization, type GoogleProvider } from "./google/oauth.ts";
import { disconnectGsc, getGscConnection, listGscSites, setGscSite } from "./services/gsc.ts";
import { disconnectGa4, getGa4Connection, listGa4Properties, setGa4Property } from "./services/ga4.ts";

export const VERSION = "0.1.0";
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(ctx: Ctx) {
  const app = new Hono();
  attachUsage(ctx);

  const baseUrl = (c: Context) => ctx.config.publicUrl ?? new URL(c.req.url).origin;

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", "frame-ancestors 'self'");
  });

  const requireAuth = async (c: Context, next: () => Promise<void>) => {
    if (ctx.config.authMode === "api_key") {
      const m = (c.req.header("authorization") ?? "").match(/^Bearer (.+)$/i);
      if (!m || !safeEqual(m[1]!, ctx.config.apiKey!)) {
        return c.json({ error: { code: "UNAUTHENTICATED", message: "Missing or invalid bearer token" } }, 401, { "WWW-Authenticate": "Bearer" });
      }
    }
    await next();
  };

  app.onError((e, c) => {
    if (e instanceof AppError) return c.json({ error: { code: e.code, message: e.message } }, e.status as never);
    console.error("unhandled error", e);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal error" } }, 500);
  });

  app.get("/api/health", (c) => {
    let dbOk = true;
    try { ctx.db.prepare("SELECT 1").get(); } catch { dbOk = false; }
    const checks = {
      auth: ctx.config.authMode === "local_noauth"
        ? { status: "ok", detail: "local_noauth — no auth, single admin user. Do not expose publicly without your own auth in front." }
        : { status: "ok", detail: "api_key — bearer token required for /api and /mcp." },
      dataforseo: ctx.dfs.configured
        ? { status: "ok", detail: "Set" }
        : { status: "warn", detail: "Not set — all SEO data features will be unavailable until it is. It is the base64 of your DataForSEO login:password." },
      ai: ctx.config.openrouterKey ? { status: "ok", detail: `Assistant enabled (model ${ctx.config.openrouterModel}).` } : { status: "ok", detail: "OPENROUTER_API_KEY not set (optional): the assistant is disabled." },
      database: dbOk ? { status: "ok" } : { status: "error", detail: "Database unreachable" },
    };
    return c.json({ status: dbOk ? "ok" : "error", version: VERSION, authMode: ctx.config.authMode, checks }, dbOk ? 200 : 503);
  });

  // ---------------- MCP (stateless JSON-RPC over HTTP) ----------------
  app.use("/mcp", requireAuth);
  app.get("/mcp", (c) => c.json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST with a JSON-RPC body" } }, 405, { Allow: "POST" }));
  app.post("/mcp", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413) }), async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const base = baseUrl(c);
    // Which client wrote a record: the user-agent product token ("node", "claude-code", ...), never taken from tool input.
    const label = ((c.req.header("user-agent") ?? "").split(/[\/\s]/)[0] || "mcp").toLowerCase().slice(0, 40);
    if (Array.isArray(body)) {
      if (body.length === 0) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
      const replies = (await Promise.all(body.map((m) => handleRpc(ctx, base, m, label)))).filter((r) => r !== null);
      return replies.length ? c.json(replies) : c.body(null, 202);
    }
    const reply = await handleRpc(ctx, base, body as never, label);
    return reply ? c.json(reply) : c.body(null, 202);
  });

  // ---------------- REST API used by the web UI ----------------
  // Google redirects the browser here without our bearer token; the single-use, project-bound state is the credential.
  const PUBLIC_API = new Set(["/api/health", "/api/gsc/oauth/callback", "/api/ga4/oauth/callback"]);
  app.use("/api/*", async (c, next) => (PUBLIC_API.has(c.req.path) ? next() : requireAuth(c, next)));
  app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: { code: "VALIDATION_ERROR", message: "Request body too large" } }, 413) }));

  const readJson = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const v = await c.req.json();
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* fallthrough */ }
    throw new AppError("VALIDATION_ERROR", "Body must be a JSON object");
  };

  app.get("/api/projects", (c) => c.json({ projects: listProjects(ctx) }));
  app.post("/api/projects", async (c) => {
    const b = await readJson(c);
    if (typeof b.name !== "string") throw new AppError("VALIDATION_ERROR", "name is required");
    return c.json({ project: createProject(ctx, b as never) }, 201);
  });
  app.get("/api/projects/:id", (c) => c.json({ project: getProject(ctx, c.req.param("id")) }));
  app.patch("/api/projects/:id", async (c) => c.json({ project: updateProject(ctx, c.req.param("id"), (await readJson(c)) as never) }));
  app.delete("/api/projects/:id", (c) => { deleteProject(ctx, c.req.param("id")); return c.body(null, 204); });

  app.post("/api/audits/:id/cancel", async (c) => {
    const b = await readJson(c);
    if (typeof b.projectId !== "string") throw new AppError("VALIDATION_ERROR", "projectId is required");
    return c.json(cancelAudit(ctx, b.projectId, c.req.param("id")));
  });

  /** Every MCP tool is also callable over REST with identical arguments and results. */
  app.post("/api/tools/:name", async (c) => {
    const name = c.req.param("name");
    const reply = await handleRpc(ctx, baseUrl(c), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: await readJson(c) } });
    const result = reply?.result as { isError?: boolean; structuredContent?: unknown; content?: { text: string }[] } | undefined;
    if (reply?.error || !result) return c.json({ error: { code: "NOT_FOUND", message: `Unknown tool ${name}` } }, 404);
    if (result.isError) {
      const message = result.content?.[0]?.text ?? "Error";
      const status = message === "NOT_FOUND" ? 404 : message.startsWith("Input validation error") ? 400 : message.includes("not available in this release") ? 501 : message === "INTERNAL_ERROR" ? 500 : 422;
      return c.json({ error: { code: message === "NOT_FOUND" ? "NOT_FOUND" : status === 400 ? "VALIDATION_ERROR" : "TOOL_ERROR", message } }, status);
    }
    return c.json({ data: result.structuredContent, text: result.content?.[0]?.text });
  });


  // ---------------- Rank tracker edit, archive and history ----------------
  app.patch("/api/projects/:id/rank-trackers/:tid", async (c) => c.json(await updateRankTracker(ctx, c.req.param("id"), c.req.param("tid"), await readJson(c))));
  app.get("/api/projects/:id/rank-trackers/:tid/keywords/:kid/history", (c) => c.json({ history: getRankKeywordHistory(ctx, c.req.param("id"), c.req.param("tid"), c.req.param("kid"), c.req.query("sinceDays")) }));
  app.get("/api/projects/:id/rank-trackers/:tid/trend", (c) => c.json({ trend: getRankConfigTrend(ctx, c.req.param("id"), c.req.param("tid"), c.req.query("device"), c.req.query("sinceDays")) }));
  app.get("/api/projects/:id/rank-trackers/:tid/matrix", (c) => c.json({ matrix: getRankPositionMatrix(ctx, c.req.param("id"), c.req.param("tid"), c.req.query("device"), c.req.query("runLimit")) }));

  // ---------------- Dashboard, AI visibility, usage & budgets ----------------
  app.get("/api/projects/:id/dashboard", (c) => c.json(getDashboard(ctx, c.req.param("id"))));
  app.post("/api/projects/:id/dashboard/steps/:step/dismiss", (c) => { dismissStep(ctx, c.req.param("id"), c.req.param("step"), true); return c.body(null, 204); });
  app.delete("/api/projects/:id/dashboard/steps/:step/dismiss", (c) => { dismissStep(ctx, c.req.param("id"), c.req.param("step"), false); return c.body(null, 204); });

  app.get("/api/ai/models", async (c) => c.json({ models: await listModels(ctx), webSearchCountries: webSearchCountries() }));
  app.post("/api/projects/:id/ai/prompt", async (c) => c.json(await explorePrompt(ctx, c.req.param("id"), await readJson(c))));
  app.post("/api/projects/:id/ai/brand", async (c) => c.json(await brandLookup(ctx, c.req.param("id"), await readJson(c))));
  app.get("/api/projects/:id/ai/runs", (c) => {
    const kind = c.req.query("kind");
    if (kind !== undefined && kind !== "prompt" && kind !== "brand") throw new AppError("VALIDATION_ERROR", "kind must be prompt or brand");
    return c.json({ runs: listRuns(ctx, c.req.param("id"), kind) });
  });
  app.get("/api/projects/:id/ai/runs/:rid", (c) => c.json(getRun(ctx, c.req.param("id"), c.req.param("rid"))));
  app.delete("/api/projects/:id/ai/runs/:rid", (c) => { deleteRun(ctx, c.req.param("id"), c.req.param("rid")); return c.body(null, 204); });

  app.get("/api/usage", (c) => {
    const days = c.req.query("days");
    return c.json(getUsage(ctx, { projectId: c.req.query("projectId") || undefined, days: days === undefined ? undefined : Number(days) }));
  });
  app.get("/api/budgets", (c) => c.json({ budgets: listBudgets(ctx) }));
  app.put("/api/budgets", async (c) => {
    const b = await readJson(c);
    if (b.projectId !== undefined && b.projectId !== null && typeof b.projectId !== "string") throw new AppError("VALIDATION_ERROR", "projectId must be text or null");
    if (b.monthlyLimitUsd !== null && typeof b.monthlyLimitUsd !== "number") throw new AppError("VALIDATION_ERROR", "monthlyLimitUsd must be a number, or null to remove the limit");
    return c.json({ budget: setBudget(ctx, (b.projectId as string | null | undefined) ?? null, b.monthlyLimitUsd as number | null), budgets: listBudgets(ctx) });
  });

  // ---------------- Assistant ----------------
  app.get("/api/projects/:id/agent/sessions", (c) => c.json({ enabled: Boolean(ctx.config.openrouterKey), model: ctx.config.openrouterModel, sessions: listSessions(ctx, c.req.param("id")) }));
  app.post("/api/projects/:id/agent/sessions", (c) => c.json({ session: createSession(ctx, c.req.param("id")) }, 201));
  app.get("/api/projects/:id/agent/sessions/:sid", (c) => c.json(getTranscript(ctx, c.req.param("id"), c.req.param("sid"))));
  app.delete("/api/projects/:id/agent/sessions/:sid", (c) => { deleteSession(ctx, c.req.param("id"), c.req.param("sid")); return c.body(null, 204); });
  app.post("/api/projects/:id/agent/sessions/:sid/messages", async (c) => {
    const b = await readJson(c);
    if (typeof b.text !== "string") throw new AppError("VALIDATION_ERROR", "text is required");
    return c.json(await runTurn(ctx, baseUrl(c), c.req.param("id"), c.req.param("sid"), b.text));
  });

  // ---------------- Google (Search Console / Analytics) ----------------
  const providerOf = (v: string): GoogleProvider => {
    if (v !== "gsc" && v !== "ga4") throw new AppError("NOT_FOUND", "Unknown provider");
    return v;
  };
  for (const provider of ["gsc", "ga4"] as const) {
    app.get(PROVIDERS[provider].callbackPath, async (c) => {
      const q = new URL(c.req.url).searchParams;
      const back = (project: string | null, params: Record<string, string>) => {
        const qs = new URLSearchParams(params).toString();
        return c.redirect(`/${qs ? `?${qs}` : ""}${project ? `#/p/${project}/integrations` : ""}`);
      };
      if (q.get("error")) return back(abandonAuthorization(ctx, provider, q.get("state")), { google_error: q.get("error")!, provider });
      try {
        const r = await completeAuthorization(ctx, provider, { code: q.get("code"), state: q.get("state") });
        return back(r.projectId, { google: "connected", provider });
      } catch (e) {
        if (e instanceof AppError) return back(null, { google_error: e.message, provider });
        throw e;
      }
    });
  }
  app.get("/api/google/status", async (c) => {
    const projectId = c.req.query("projectId") ?? "";
    getProject(ctx, projectId);
    const configured = googleConfigured(ctx);
    const gsc = getGscConnection(ctx, projectId), ga4 = getGa4Connection(ctx, projectId);
    return c.json({
      configured, redirectUris: Object.fromEntries((["gsc", "ga4"] as const).map((p) => [p, `${baseUrl(c)}${PROVIDERS[p].callbackPath}`])),
      gsc: { connection: gsc ? { siteUrl: gsc.site_url, email: gsc.connected_email } : null, accounts: configured ? (await listGscSites(ctx)).accounts : [] },
      ga4: { connection: ga4 ? { propertyId: ga4.property_id, displayName: ga4.property_display_name, timeZone: ga4.property_time_zone, email: ga4.connected_email } : null, accounts: configured ? (await listGa4Properties(ctx)).accounts : [] },
    });
  });
  app.post("/api/google/:provider/start", async (c) => {
    const b = await readJson(c);
    if (typeof b.projectId !== "string") throw new AppError("VALIDATION_ERROR", "projectId is required");
    return c.json(startAuthorization(ctx, providerOf(c.req.param("provider")), b.projectId, baseUrl(c)));
  });
  app.post("/api/google/:provider/select", async (c) => {
    const b = await readJson(c);
    if (typeof b.projectId !== "string" || typeof b.grantId !== "string") throw new AppError("VALIDATION_ERROR", "projectId and grantId are required");
    if (providerOf(c.req.param("provider")) === "gsc") {
      if (typeof b.siteUrl !== "string") throw new AppError("VALIDATION_ERROR", "siteUrl is required");
      await setGscSite(ctx, b.projectId, { grantId: b.grantId, siteUrl: b.siteUrl });
    } else {
      if (typeof b.propertyId !== "string") throw new AppError("VALIDATION_ERROR", "propertyId is required");
      await setGa4Property(ctx, b.projectId, { grantId: b.grantId, propertyId: b.propertyId });
    }
    return c.json({ ok: true });
  });
  app.delete("/api/google/:provider/:projectId", (c) => {
    getProject(ctx, c.req.param("projectId"));
    if (providerOf(c.req.param("provider")) === "gsc") disconnectGsc(ctx, c.req.param("projectId")); else disconnectGa4(ctx, c.req.param("projectId"));
    return c.body(null, 204);
  });

  /** Links in tool results use path-style URLs (/p/<id>/<page>); map them onto the hash-routed UI. */
  const TAB: Record<string, string> = { keywords: "keywords", saved: "saved", domain: "domain", backlinks: "backlinks", "rank-tracking": "rank", audit: "audit", reports: "reports", context: "context", settings: "settings", "search-performance": "integrations", integrations: "integrations", "brand-lookup": "keywords", "prompt-explorer": "keywords", sam: "keywords" };
  app.get("/p/:id/:tab?/:rest?/:rest2?", (c) => {
    const { id, tab, rest, rest2 } = c.req.param();
    let t = TAB[tab ?? ""] ?? "keywords";
    if (tab === "settings" && rest === "integrations") t = "integrations";
    const sub = (tab === "rank-tracking" || tab === "audit" || tab === "reports") && rest && rest !== "templates" && rest !== "issues" ? `/${rest}` : tab === "audit" && rest === "issues" && rest2 ? `/${rest2}` : "";
    return c.redirect(`/#/p/${id}/${t}${sub}`);
  });

  /** The stored report document (structured tool results carry metadata only). */
  app.get("/api/projects/:id/reports/:rid/html", (c) => {
    const r = ctx.db.prepare("SELECT html FROM reports WHERE id=? AND project_id=?").get(c.req.param("rid"), c.req.param("id")) as { html: string } | undefined;
    if (!r) return c.json({ error: { code: "NOT_FOUND", message: "Report not found" } }, 404);
    return c.body(r.html, 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:", "Cache-Control": "no-store" });
  });
  app.get("/api/tools", (c) => c.json({ tools: Object.keys(HANDLERS) }));
  app.all("/api/*", (c) => c.json({ error: { code: "NOT_FOUND", message: "No such API route" } }, 404));

  // ---------------- Public report sharing ----------------
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  app.get("/s/:token", (c) => {
    if (!ctx.config.enablePublicSharing) return c.text("Not found", 404);
    const r = getSharedReport(ctx, c.req.param("token"));
    if (!r) return c.text("Not found", 404);
    const token = c.req.param("token");
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(r.title)}</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" src="/s/${token}/raw" title="${esc(r.title)}"></iframe>`,
      200, { "Content-Security-Policy": "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'" });
  });
  app.get("/s/:token/raw", (c) => {
    if (!ctx.config.enablePublicSharing) return c.text("Not found", 404);
    const r = getSharedReport(ctx, c.req.param("token"));
    if (!r) return c.text("Not found", 404);
    return c.body(r.html, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'",
      "X-Robots-Tag": "noindex", "Cache-Control": "no-store",
    });
  });
  app.get("/r/:id", (c) => {
    const row = ctx.db.prepare("SELECT project_id FROM reports WHERE id=?").get(c.req.param("id")) as { project_id: string } | undefined;
    return row ? c.redirect(`/#/p/${row.project_id}/reports/${c.req.param("id")}`) : c.text("Not found", 404);
  });

  // ---------------- Static web UI ----------------
  app.get("*", async (c) => {
    let rel = decodeURIComponent(c.req.path);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + sep)) return c.text("Not found", 404);
    try {
      const data = await readFile(file);
      return c.body(data, 200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    } catch {
      return c.text("Not found", 404);
    }
  });

  return app;
}
