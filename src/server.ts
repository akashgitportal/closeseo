import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { DfsClient } from "./dfs/client.ts";
import type { Ctx } from "./ctx.ts";
import { awaitAudits, failInterruptedAudits } from "./services/audit.ts";
import { awaitRankRuns, failInterruptedRuns, runDueTrackers } from "./services/rankTracking.ts";

const config = loadConfig();
const db = openDb(config.databasePath);
const ctx: Ctx = { db, config, dfs: new DfsClient({ apiKey: config.dataforseoKey, baseUrl: config.dataforseoBaseUrl, retryDelayMs: config.dfsRetryDelayMs }) };

const recovered = failInterruptedRuns(ctx) + failInterruptedAudits(ctx);
if (recovered) console.warn(`${recovered} job(s) were still running when the server stopped and are now marked failed`);

const server = serve({ fetch: createApp(ctx).fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`CloseSEO listening on http://${info.address}:${info.port} (auth: ${config.authMode}, db: ${config.databasePath})`);
  if (!config.dataforseoKey) console.warn("No DATAFORSEO_API_KEY configured, so the SEO data features are switched off.");
  if (config.authMode === "local_noauth" && config.host !== "127.0.0.1" && config.host !== "localhost")
    console.warn("WARNING: local_noauth is bound to a non-loopback address, which leaves an admin interface open to anyone. Put authentication in front of it or use AUTH_MODE=api_key.");
});

const tick = setInterval(() => {
  try { runDueTrackers(ctx); } catch (e) { console.error("scheduler error", e); }
}, 60_000);
if (config.disableScheduler) clearInterval(tick);
tick.unref();

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received; shutting down…`);
  clearInterval(tick);
  server.close();
  await Promise.race([Promise.all([awaitRankRuns(), awaitAudits()]), new Promise((r) => setTimeout(r, 10_000))]);
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
