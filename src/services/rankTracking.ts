import { withUsage } from "./usage.ts";
import type { Ctx } from "../ctx.ts";
import { newId, nowIso, tx } from "../db.ts";
import { hostMatchesDomain } from "../domain-utils.ts";
import { AppError } from "../errors.ts";
import { getProject } from "./projects.ts";
import { fetchSerp, type SerpItem } from "./serp.ts";
import { serpLocationsForCountry } from "./keywords.ts";
import { isoCountryCode, resolveMarket, type Market } from "./markets.ts";
import { computeNextCheckAt, isValidTimeZone, type ScheduleInterval, type ScheduleTime, type ScheduledInterval } from "./schedule.ts";
import { MAX_TASKS_PER_POST, devicesCount, estimateRankCheck, estimateScheduled, type Devices } from "./rankPricing.ts";

export type { Devices } from "./rankPricing.ts";
const MAX_KEYWORDS_PER_CONFIG = 1000;
const MAX_CONFIGS_PER_PROJECT = 500;
const CONCURRENCY = 5;
const COMPARE_DAYS = 7;
const deviceList = (d: Devices) => (d === "both" ? (["desktop", "mobile"] as const) : ([d] as const));

type TrackerRow = {
  id: string; project_id: string; domain: string; location_code: number; language_code: string; location_name: string | null;
  devices: Devices; serp_depth: number; schedule_interval: ScheduleInterval; next_run_at: string | null; created_at: string;
  is_active: number; last_skip_reason: string | null;
};

/** UTC timestamp as "YYYY-MM-DD HH:MM:SS", the format stored for tracker dates. */
const sqlTs = (d = new Date()) => d.toISOString().slice(0, 19).replace("T", " ");

function toConfig(ctx: Ctx, r: TrackerRow) {
  const last = ctx.db.prepare("SELECT MAX(s.checked_at) AS t FROM rank_snapshots s JOIN rank_runs u ON u.id=s.run_id WHERE u.tracker_id=?").get(r.id) as { t: string | null };
  return {
    id: r.id, projectId: r.project_id, domain: r.domain, locationCode: r.location_code, languageCode: r.language_code, locationName: r.location_name,
    devices: r.devices, serpDepth: r.serp_depth, scheduleInterval: r.schedule_interval, nextCheckAt: r.next_run_at, isActive: r.is_active === 1,
    lastCheckedAt: last.t, lastSkipReason: r.last_skip_reason, createdAt: r.created_at,
  };
}

function tracker(ctx: Ctx, projectId: string, trackerId: string): TrackerRow {
  const r = ctx.db.prepare("SELECT * FROM rank_trackers WHERE id=? AND project_id=?").get(trackerId, projectId) as TrackerRow | undefined;
  if (!r) throw new AppError("NOT_FOUND", "No such rank tracker in this project");
  return r;
}
const keywordsOf = (ctx: Ctx, trackerId: string) => ctx.db.prepare("SELECT id, keyword, match_case, search_volume, keyword_difficulty, cpc FROM rank_tracker_keywords WHERE tracker_id=? ORDER BY created_at, rowid").all(trackerId) as
  { id: string; keyword: string; match_case: number; search_volume: number | null; keyword_difficulty: number | null; cpc: number | null }[];

function normalizeTrackedDomain(input: string): string {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\/+$/, "").replace(/^www\./, "");
  if (!d) throw new AppError("VALIDATION_ERROR", "That is not a usable domain");
  return d;
}

function resolveNextCheckAt(interval: ScheduleInterval, time: ScheduleTime | undefined): string | null {
  if (interval !== "manual") {
    if (interval === "weekly" && time && time.weekday === undefined) throw new AppError("VALIDATION_ERROR", "Weekly checks need a weekday for the run time");
    return computeNextCheckAt(interval, null, time);
  }
  if (time) throw new AppError("VALIDATION_ERROR", "A run time only applies to daily, weekly or monthly schedules");
  return null;
}

export async function createRankTracker(
  ctx: Ctx, projectId: string,
  i: { domain?: string; locationCode?: number; languageCode?: string; locationName?: string; devices?: Devices; serpDepth?: number; scheduleInterval?: ScheduleInterval; scheduleTime?: ScheduleTime },
) {
  const p = getProject(ctx, projectId);
  const domainInput = i.domain ?? p.domain;
  if (!domainInput) throw new AppError("VALIDATION_ERROR", "Give a domain, or set a domain on the project first");
  const domain = normalizeTrackedDomain(domainInput);
  const m = resolveMarket(i, p);
  const interval = i.scheduleInterval ?? "manual";
  if (i.scheduleTime?.timeZone && !isValidTimeZone(i.scheduleTime.timeZone)) throw new AppError("VALIDATION_ERROR", `"${i.scheduleTime.timeZone}" is not a recognised time zone`);
  const next = resolveNextCheckAt(interval, i.scheduleTime);
  const locationName = i.locationName ?? null;
  if (locationName) {
    const all = await serpLocationsForCountry(ctx, isoCountryCode(m.locationCode));
    if (!all.some((l) => l.location_name === locationName)) throw new AppError("VALIDATION_ERROR", `"${locationName}" does not match any place we can look up in this country`);
  }
  const dup = ctx.db.prepare("SELECT 1 FROM rank_trackers WHERE project_id=? AND domain=? AND location_code=? AND COALESCE(location_name,'')=? AND is_active=1").get(projectId, domain, m.locationCode, locationName ?? "");
  if (dup) throw new AppError("VALIDATION_ERROR", locationName ? "That domain is already tracked for this city" : "That domain is already tracked for this country");
  const count = (ctx.db.prepare("SELECT COUNT(*) AS n FROM rank_trackers WHERE project_id=?").get(projectId) as { n: number }).n;
  if (count >= MAX_CONFIGS_PER_PROJECT) throw new AppError("VALIDATION_ERROR", `A project can track at most ${MAX_CONFIGS_PER_PROJECT} domains`);
  const id = newId();
  ctx.db.prepare(
    `INSERT INTO rank_trackers (id,project_id,domain,location_code,language_code,location_name,devices,serp_depth,schedule_interval,next_run_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, projectId, domain, m.locationCode, m.languageCode, locationName, i.devices ?? "mobile", i.serpDepth ?? 40, interval, next, sqlTs());
  return { trackerId: id, config: toConfig(ctx, tracker(ctx, projectId, id)) };
}

type Snap = { keyword_id: string; device: string; position: number | null; url: string | null; serp_features: string | null; checked_at: string };

export function getRankTracker(ctx: Ctx, projectId: string, trackerId?: string) {
  getProject(ctx, projectId);
  if (!trackerId) {
    const rows = ctx.db.prepare("SELECT * FROM rank_trackers WHERE project_id=? AND is_active=1 ORDER BY created_at, rowid").all(projectId) as TrackerRow[];
    return { configs: rows.map((r) => toConfig(ctx, r)) };
  }
  const t = tracker(ctx, projectId, trackerId);
  const snaps = ctx.db.prepare("SELECT s.keyword_id, s.device, s.position, s.url, s.serp_features, s.checked_at FROM rank_snapshots s JOIN rank_runs u ON u.id=s.run_id WHERE u.tracker_id=? ORDER BY s.checked_at, s.rowid").all(t.id) as Snap[];
  const latest = new Map<string, Snap>(), earliest = new Map<string, Snap>(), beforeCutoff = new Map<string, Snap>();
  const cutoff = sqlTs(new Date(Date.now() - COMPARE_DAYS * 86_400_000));
  for (const s of snaps) {
    const key = `${s.keyword_id}:${s.device}`;
    latest.set(key, s);
    if (!earliest.has(key)) earliest.set(key, s);
    if (s.checked_at.replace("T", " ").slice(0, 19) <= cutoff) beforeCutoff.set(key, s);
  }
  const features = (raw: string | null): string[] => { try { const v = JSON.parse(raw ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
  const device = (kwId: string, dev: "desktop" | "mobile") => {
    const key = `${kwId}:${dev}`;
    const cur = latest.get(key);
    // "Previous" means the latest check older than the comparison window, falling back to the very first check.
    const prev = (beforeCutoff.get(key) ?? earliest.get(key))?.position ?? null;
    return { position: cur?.position ?? null, previousPosition: prev, rankingUrl: cur?.url ?? null, serpFeatures: cur ? features(cur.serp_features) : [] };
  };
  const rows = keywordsOf(ctx, t.id).map((k) => ({
    trackingKeywordId: k.id, keyword: k.keyword, matchCase: k.match_case === 1, searchVolume: k.search_volume, keywordDifficulty: k.keyword_difficulty, cpc: k.cpc,
    desktop: device(k.id, "desktop"), mobile: device(k.id, "mobile"),
  }));
  const run = ctx.db.prepare("SELECT * FROM rank_runs WHERE tracker_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(t.id) as { id: string; status: "pending" | "running" | "completed" | "failed"; error_message: string | null; completed_at: string | null } | undefined;
  let lastChecked: string | null = null;
  for (const s of latest.values()) if (!lastChecked || s.checked_at > lastChecked) lastChecked = s.checked_at;
  return { config: toConfig(ctx, t), results: { rows, run: run ? { id: run.id, lastCheckedAt: lastChecked, completedAt: run.completed_at, status: run.status, errorMessage: run.error_message } : null } };
}

const scheduledOf = (t: TrackerRow): ScheduledInterval | null => (t.schedule_interval === "manual" ? null : t.schedule_interval);

function scheduledGateError(interval: ScheduledInterval, e: ReturnType<typeof estimateScheduled>) {
  return new AppError("VALIDATION_ERROR",
    `With these keywords every ${interval} check would cost about ${e.costCredits} credits at queued prices (around $${e.costUsd.toFixed(4)} each, roughly ${e.monthlyCostCredits} credits a month). Run estimate_rank_tracker_cost with additionalKeywords, tell the user the recurring price, and mention that any task that is rejected, fails or times out is re-run live and billed again. Once they agree, repeat the call with maxEstimatedScheduledCheckCredits set to the per-check figure they accepted.`);
}

export function addRankTrackingKeywords(
  ctx: Ctx, projectId: string,
  i: { trackerId: string; keywords: string[]; matchCase?: boolean; maxEstimatedScheduledCheckCredits?: number },
) {
  const t = tracker(ctx, projectId, i.trackerId);
  const existing = keywordsOf(ctx, t.id);
  if (existing.length >= MAX_KEYWORDS_PER_CONFIG) throw new AppError("VALIDATION_ERROR", `A tracked domain can hold at most ${MAX_KEYWORDS_PER_CONFIG} keywords; this one already has ${existing.length}`);
  const matchCase = Boolean(i.matchCase);
  const have = new Set(existing.map((k) => k.keyword));
  const seen = new Set<string>();
  const fresh: string[] = [];
  for (const raw of i.keywords) {
    if (fresh.length >= MAX_KEYWORDS_PER_CONFIG - existing.length) break;
    const trimmed = raw.trim();
    const norm = matchCase ? trimmed : trimmed.toLowerCase();
    if (norm && !seen.has(norm) && !have.has(norm)) { seen.add(norm); fresh.push(norm); }
  }
  const interval = scheduledOf(t);
  let est: ReturnType<typeof estimateScheduled> | undefined;
  if (fresh.length > 0 && interval) {
    est = estimateScheduled([...existing.map((k) => k.keyword), ...fresh], t.devices, t.serp_depth, interval, ctx.config.creditMarkup);
    // Scheduled trackers only accept new keywords when the caller names the per-check price they accept.
    if (i.maxEstimatedScheduledCheckCredits == null || est.costCredits > i.maxEstimatedScheduledCheckCredits) throw scheduledGateError(interval, est);
  }
  const addedIds: string[] = [];
  tx(ctx.db, () => {
    for (const k of fresh) {
      const id = newId();
      ctx.db.prepare("INSERT INTO rank_tracker_keywords (id,tracker_id,keyword,match_case,created_at) VALUES (?,?,?,?,?)").run(id, t.id, k, matchCase ? 1 : 0, nowIso());
      addedIds.push(id);
    }
  });
  return { trackerId: t.id, requested: i.keywords.length, added: addedIds.length, addedIds, ...(est ? { scheduledEstimate: est } : {}) };
}

export function removeRankTrackingKeywords(ctx: Ctx, projectId: string, i: { trackerId: string; keywordIds: string[] }) {
  const t = tracker(ctx, projectId, i.trackerId);
  const removedIds: string[] = [];
  tx(ctx.db, () => {
    for (const id of new Set(i.keywordIds))
      if (Number(ctx.db.prepare("DELETE FROM rank_tracker_keywords WHERE id=? AND tracker_id=?").run(id, t.id).changes) > 0) removedIds.push(id);
  });
  return { trackerId: t.id, requested: i.keywordIds.length, removed: removedIds.length, removedIds };
}

export function estimateRankTrackerCost(ctx: Ctx, projectId: string, i: { trackerId: string; additionalKeywordCount?: number; additionalKeywords?: string[] }) {
  const t = tracker(ctx, projectId, i.trackerId);
  const existing = keywordsOf(ctx, t.id).map((k) => k.keyword);
  // With only a count (no text) there is nothing to inspect, so price them as ordinary keywords.
  const extra = i.additionalKeywords ?? Array<string>(i.additionalKeywordCount ?? 0).fill("");
  const keywords = [...existing, ...extra].slice(0, Math.max(existing.length, MAX_KEYWORDS_PER_CONFIG));
  const { costUsd, costCredits } = estimateRankCheck(keywords, t.devices, t.serp_depth, "live", ctx.config.creditMarkup);
  const interval = scheduledOf(t);
  return {
    trackerId: t.id, costUsd, costCredits, keywordCount: keywords.length, devicesCount: devicesCount(t.devices), totalChecks: keywords.length * devicesCount(t.devices),
    method: "live" as const, existingKeywordCount: existing.length, additionalKeywordCount: keywords.length - existing.length,
    ...(interval ? { scheduledEstimate: estimateScheduled(keywords, t.devices, t.serp_depth, interval, ctx.config.creditMarkup) } : {}),
  };
}

const inflight = new Set<Promise<unknown>>();
/** Waits until all background rank runs have finished; used by tests and shutdown. */
export async function awaitRankRuns() {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

export function runRankTracker(ctx: Ctx, projectId: string, i: { trackerId: string; maxCostCredits: number }, trigger: "manual" | "scheduled" = "manual") {
  return withUsage({ projectId, feature: "rank_tracking" }, () => startRankRun(ctx, projectId, i, trigger));
}

function startRankRun(ctx: Ctx, projectId: string, i: { trackerId: string; maxCostCredits: number }, trigger: "manual" | "scheduled") {
  const t = tracker(ctx, projectId, i.trackerId);
  const kws = keywordsOf(ctx, t.id);
  if (kws.length === 0) throw new AppError("VALIDATION_ERROR", "This tracker has no keywords yet; add some before checking");
  const method = trigger === "scheduled" ? "queued" : "live";
  if (trigger === "manual") {
    const { costCredits } = estimateRankCheck(kws.map((k) => k.keyword), t.devices, t.serp_depth, "live", ctx.config.creditMarkup);
    if (costCredits > i.maxCostCredits)
      throw new AppError("VALIDATION_ERROR", `This check would cost ${costCredits} credits, more than the ${i.maxCostCredits} that was approved. Get a fresh figure from estimate_rank_tracker_cost and have the user confirm it before retrying`);
  }
  const active = ctx.db.prepare("SELECT id FROM rank_runs WHERE tracker_id=? AND status IN ('pending','running') ORDER BY created_at LIMIT 1").get(t.id) as { id: string } | undefined;
  if (active) return { trackerId: t.id, started: false, blockingRunId: active.id };
  if (!ctx.dfs.configured) throw new AppError("NOT_CONFIGURED", "No DataForSEO key is configured (DATAFORSEO_API_KEY)");
  const runId = newId();
  ctx.db.prepare("INSERT INTO rank_runs (id,tracker_id,status,trigger,keywords_total,created_at) VALUES (?,?,'pending',?,?,?)").run(runId, t.id, trigger, kws.length, nowIso());
  const p = executeRun(ctx, t, runId, method).finally(() => inflight.delete(p));
  inflight.add(p);
  return { trackerId: t.id, started: true, runId };
}

type Check = { k: { id: string; keyword: string }; device: "desktop" | "mobile" };
const serpFeatures = (items: SerpItem[]) => [...new Set(items.map((i) => i.type).filter((x): x is string => !!x && x !== "organic"))];

async function executeRun(ctx: Ctx, t: TrackerRow, runId: string, method: "live" | "queued") {
  ctx.db.prepare("UPDATE rank_runs SET status='running', started_at=? WHERE id=?").run(nowIso(), runId);
  const kws = keywordsOf(ctx, t.id);
  const checks: Check[] = kws.flatMap((k) => deviceList(t.devices).map((device) => ({ k, device })));
  const market: Market = { locationCode: t.location_code, languageCode: t.language_code };
  let cost = 0, failures = 0, done = 0, fatal: string | null = null, firstError = "";

  const save = (c: Check, items: SerpItem[]) => {
    const hit = items.find((it) => it.type === "organic" && it.domain && hostMatchesDomain(it.domain.replace(/^www\./, ""), t.domain));
    ctx.db.prepare("INSERT INTO rank_snapshots (id,run_id,keyword_id,keyword,device,position,url,serp_features,checked_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(newId(), runId, c.k.id, c.k.keyword, c.device, hit?.rank ?? null, hit?.url ?? null, JSON.stringify(serpFeatures(items)), nowIso());
    done++;
  };
  const fail = (e: unknown) => {
    failures++;
    firstError ||= (e as Error).message;
    if (e instanceof AppError && (e.code === "UNAUTHENTICATED" || e.code === "NOT_CONFIGURED")) fatal = e.message;
  };
  const live = async (list: Check[]) => {
    let cursor = 0;
    const worker = async () => {
      while (!fatal) {
        const c = list[cursor++];
        if (!c) return;
        try {
          const r = await fetchSerp(ctx, { keyword: c.k.keyword, market, depth: t.serp_depth, device: c.device, ignoreSnippetTypes: true });
          cost += r.costUsd; save(c, r.items);
        } catch (e) { fail(e); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  };

  try {
    if (method === "live") await live(checks);
    else {
      // Queued checks go out in batches and are polled; whatever is rejected, fails or runs out of time is re-checked live.
      const leftovers: Check[] = [];
      for (let i = 0; i < checks.length && !fatal; i += MAX_TASKS_PER_POST) {
        const batch = checks.slice(i, i + MAX_TASKS_PER_POST);
        let posted: Awaited<ReturnType<typeof ctx.dfs.post>>;
        try {
          posted = await ctx.dfs.post("/v3/serp/google/organic/task_post", batch.map((c) => ({
            keyword: c.k.keyword, location_code: t.location_code, language_code: t.language_code, depth: t.serp_depth, device: c.device, priority: 1,
          })));
        } catch (e) { if (e instanceof AppError && (e.code === "UNAUTHENTICATED" || e.code === "NOT_CONFIGURED")) { fail(e); break; } leftovers.push(...batch); continue; }
        const pending = new Map<string, Check>();
        batch.forEach((c, idx) => { const p = posted[idx]; if (p?.id && p.statusCode === 20100) pending.set(p.id, c); else leftovers.push(c); });
        const deadline = Date.now() + ctx.config.rankQueueTimeoutMs;
        while (pending.size && Date.now() < deadline && !fatal) {
          await new Promise((r) => setTimeout(r, ctx.config.rankPollMs));
          for (const [id, c] of [...pending]) {
            try {
              const r = await ctx.dfs.getTask<{ items?: { type?: string; rank_group?: number; rank_absolute?: number; title?: string; url?: string; domain?: string; description?: string }[] | null }>(`/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(id)}`);
              if (r.ready) {
                pending.delete(id); cost += r.costUsd;
                save(c, (r.result?.items ?? []).map((it) => ({ type: it.type ?? null, rank: it.rank_absolute ?? it.rank_group ?? null, title: it.title ?? null, url: it.url ?? null, domain: it.domain ?? null, description: it.description ?? null })));
              } else if (r.statusCode >= 40000 && r.statusCode !== 40602) { pending.delete(id); leftovers.push(c); }
            } catch (e) { if (e instanceof AppError && (e.code === "UNAUTHENTICATED" || e.code === "NOT_CONFIGURED")) { fail(e); pending.clear(); } }
          }
        }
        leftovers.push(...pending.values());
      }
      if (!fatal && leftovers.length) await live(leftovers);
    }
    const failed = fatal !== null || (checks.length > 0 && failures === checks.length);
    ctx.db.prepare("UPDATE rank_runs SET status=?, error_message=?, cost_usd=?, keywords_checked=?, completed_at=? WHERE id=?").run(
      failed ? "failed" : "completed",
      failed ? (fatal ?? firstError) : failures > 0 ? `${failures} of ${checks.length} checks failed: ${firstError}` : null,
      cost, new Set(ctx.db.prepare("SELECT keyword_id FROM rank_snapshots WHERE run_id=?").all(runId).map((r) => (r as { keyword_id: string }).keyword_id)).size, nowIso(), runId,
    );
  } catch (e) {
    ctx.db.prepare("UPDATE rank_runs SET status='failed', error_message=?, completed_at=? WHERE id=?").run((e as Error).message, nowIso(), runId);
  }
  void done;
}

/** Run at startup: a run still marked active after a restart will never complete, so mark it failed. */
export function failInterruptedRuns(ctx: Ctx): number {
  return Number(ctx.db.prepare("UPDATE rank_runs SET status='failed', error_message='Stopped because the server restarted', completed_at=? WHERE status IN ('pending','running')").run(nowIso()).changes);
}

/** Starts each active tracker whose scheduled time has passed and returns how many were started. */
export function runDueTrackers(ctx: Ctx, now = new Date()): number {
  const due = ctx.db.prepare("SELECT * FROM rank_trackers WHERE is_active=1 AND schedule_interval!='manual' AND next_run_at IS NOT NULL AND next_run_at<=?").all(now.toISOString()) as TrackerRow[];
  let started = 0;
  for (const t of due) {
    // Step forward from the old anchor so a late timer tick does not shift the schedule.
    const next = computeNextCheckAt(t.schedule_interval as ScheduledInterval, t.next_run_at, undefined, now.getTime());
    ctx.db.prepare("UPDATE rank_trackers SET next_run_at=? WHERE id=?").run(next, t.id);
    try {
      const r = runRankTracker(ctx, t.project_id, { trackerId: t.id, maxCostCredits: Number.MAX_SAFE_INTEGER }, "scheduled");
      if (r.started) started++;
    } catch (e) {
      const reason = (e as Error).message.startsWith("This tracker has no keywords") ? "no_keywords" : null;
      if (reason) ctx.db.prepare("UPDATE rank_trackers SET last_skip_reason=? WHERE id=?").run(reason, t.id);
    }
  }
  return started;
}

// ---------------- edit, archive and history ----------------

const DEVICES = ["desktop", "mobile", "both"] as const;
const INTERVALS = ["manual", "daily", "weekly", "monthly"] as const;

/** Edits a tracker (domain, market, devices, depth, schedule) or archives/restores it; `isActive: false` removes it from the list. */
export async function updateRankTracker(ctx: Ctx, projectId: string, trackerId: string, i: Record<string, any>) {
  const t = tracker(ctx, projectId, trackerId);
  const bad = (m: string) => new AppError("VALIDATION_ERROR", m);
  if (i.devices !== undefined && !(DEVICES as readonly unknown[]).includes(i.devices)) throw bad("devices has to be desktop, mobile or both");
  if (i.scheduleInterval !== undefined && !(INTERVALS as readonly unknown[]).includes(i.scheduleInterval)) throw bad("scheduleInterval has to be manual, daily, weekly or monthly");
  if (i.serpDepth !== undefined && (!Number.isInteger(i.serpDepth) || i.serpDepth < 10 || i.serpDepth > 100 || i.serpDepth % 10 !== 0)) throw bad("serpDepth has to be 10, 20, … up to 100");
  if (i.isActive !== undefined && typeof i.isActive !== "boolean") throw bad("isActive has to be true or false");
  if (i.locationCode !== undefined && (!Number.isInteger(i.locationCode) || i.locationCode <= 0)) throw bad("locationCode has to be a positive whole number");
  if (i.scheduleTime?.timeZone && !isValidTimeZone(i.scheduleTime.timeZone)) throw bad(`"${i.scheduleTime.timeZone}" is not a recognised time zone`);
  const set: Record<string, unknown> = {};
  if (i.domain !== undefined) set.domain = normalizeTrackedDomain(String(i.domain));
  if (i.locationCode !== undefined) set.location_code = i.locationCode;
  if (i.languageCode !== undefined) { if (typeof i.languageCode !== "string" || !i.languageCode) throw bad("languageCode has to be text"); set.language_code = i.languageCode; }
  if (i.locationName !== undefined) {
    if (i.locationName !== null && (typeof i.locationName !== "string" || !i.locationName || i.locationName.length > 200)) throw bad("locationName has to be 1–200 characters, or null to clear it");
    set.location_name = i.locationName;
  }
  if (i.devices !== undefined) set.devices = i.devices;
  if (i.serpDepth !== undefined) set.serp_depth = i.serpDepth;
  if (i.isActive !== undefined) set.is_active = i.isActive ? 1 : 0;

  const locationCode = (set.location_code as number | undefined) ?? t.location_code;
  const locationName = (set.location_name as string | null | undefined) === undefined ? t.location_name : (set.location_name as string | null);
  const marketChanged = i.locationName !== undefined || i.locationCode !== undefined || i.languageCode !== undefined;
  if (marketChanged && locationName) {
    const all = await serpLocationsForCountry(ctx, isoCountryCode(locationCode));
    if (!all.some((l) => l.location_name === locationName)) throw bad(`"${locationName}" does not match any place we can look up in this country`);
  }
  const identityChanged = set.domain !== undefined || set.location_code !== undefined || i.locationName !== undefined || i.isActive === true;
  if (identityChanged && ((set.is_active ?? t.is_active) === 1)) {
    const dup = ctx.db.prepare("SELECT 1 FROM rank_trackers WHERE project_id=? AND domain=? AND location_code=? AND COALESCE(location_name,'')=? AND is_active=1 AND id<>?")
      .get(projectId, (set.domain as string | undefined) ?? t.domain, locationCode, locationName ?? "", t.id);
    if (dup) throw bad(locationName ? "That domain is already tracked for this city" : "That domain is already tracked for this country");
  }
  // Only re-anchor the schedule when it actually changed, so editing something else keeps the run time.
  const interval = (i.scheduleInterval ?? t.schedule_interval) as ScheduleInterval;
  if (i.scheduleTime || interval !== t.schedule_interval || (interval !== "manual" && !t.next_run_at)) {
    set.schedule_interval = interval;
    set.next_run_at = resolveNextCheckAt(interval, i.scheduleTime);
  }
  const keys = Object.keys(set);
  if (keys.length) ctx.db.prepare(`UPDATE rank_trackers SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`).run(...(keys.map((k) => set[k]) as never[]), t.id);
  return { config: toConfig(ctx, tracker(ctx, projectId, trackerId)) };
}

function sinceDays(v: unknown): number {
  const n = v === undefined || v === null || v === "" ? 365 : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 730) throw new AppError("VALIDATION_ERROR", "sinceDays has to be a whole number between 1 and 730");
  return n;
}
function deviceOf(v: unknown): "desktop" | "mobile" {
  if (v !== "desktop" && v !== "mobile") throw new AppError("VALIDATION_ERROR", "device has to be desktop or mobile");
  return v;
}

/** All finished checks for a single keyword, earliest first. */
export function getRankKeywordHistory(ctx: Ctx, projectId: string, trackerId: string, keywordId: string, days?: unknown) {
  const t = tracker(ctx, projectId, trackerId);
  const cutoff = sqlTs(new Date(Date.now() - sinceDays(days) * 86_400_000));
  return (ctx.db.prepare(
    `SELECT s.device, s.checked_at AS checkedAt, s.position FROM rank_snapshots s JOIN rank_runs u ON u.id=s.run_id
     WHERE u.tracker_id=? AND u.status='completed' AND s.keyword_id=? AND s.checked_at>=? ORDER BY s.checked_at, s.rowid`,
  ).all(t.id, keywordId, cutoff) as { device: "desktop" | "mobile"; checkedAt: string; position: number | null }[]);
}

/** For each finished run, a count of keywords in positions 1-3, 4-10, 11-20 and everywhere else (unranked included). */
export function getRankConfigTrend(ctx: Ctx, projectId: string, trackerId: string, device: unknown, days?: unknown) {
  const t = tracker(ctx, projectId, trackerId);
  const dev = deviceOf(device);
  const cutoff = sqlTs(new Date(Date.now() - sinceDays(days) * 86_400_000));
  const rows = ctx.db.prepare(
    `SELECT s.run_id AS runId, u.started_at AS checkedAt, COUNT(*) AS total,
       SUM(CASE WHEN s.position BETWEEN 1 AND 3 THEN 1 ELSE 0 END) AS top3,
       SUM(CASE WHEN s.position BETWEEN 4 AND 10 THEN 1 ELSE 0 END) AS top4to10,
       SUM(CASE WHEN s.position BETWEEN 11 AND 20 THEN 1 ELSE 0 END) AS top11to20
     FROM rank_snapshots s JOIN rank_runs u ON u.id=s.run_id
     WHERE u.tracker_id=? AND u.status='completed' AND s.device=? AND s.checked_at>=? GROUP BY s.run_id, u.started_at ORDER BY u.started_at`,
  ).all(t.id, dev, cutoff) as { runId: string; checkedAt: string; total: number; top3: number; top4to10: number; top11to20: number }[];
  return rows.map((r) => ({ runId: r.runId, checkedAt: r.checkedAt, top3: r.top3 || 0, top4to10: r.top4to10 || 0, top11to20: r.top11to20 || 0, notRanking: Math.max(0, r.total - (r.top3 || 0) - (r.top4to10 || 0) - (r.top11to20 || 0)) }));
}

/** Keyword positions across the latest finished runs (12 by default, 26 at most), earliest run first. */
export function getRankPositionMatrix(ctx: Ctx, projectId: string, trackerId: string, device: unknown, limit?: unknown) {
  const t = tracker(ctx, projectId, trackerId);
  const dev = deviceOf(device);
  const n = limit === undefined || limit === null || limit === "" ? 12 : Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 26) throw new AppError("VALIDATION_ERROR", "runLimit has to be a whole number between 1 and 26");
  return ctx.db.prepare(
    `SELECT s.run_id AS runId, u.started_at AS checkedAt, s.keyword_id AS trackingKeywordId, s.position AS position
     FROM rank_snapshots s JOIN rank_runs u ON u.id=s.run_id
     WHERE s.device=? AND s.run_id IN (SELECT id FROM rank_runs WHERE tracker_id=? AND status='completed' ORDER BY started_at DESC, rowid DESC LIMIT ?)
     ORDER BY u.started_at, s.rowid`,
  ).all(dev, t.id, n) as { runId: string; checkedAt: string; trackingKeywordId: string; position: number | null }[];
}
