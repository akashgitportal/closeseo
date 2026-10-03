import type { Ctx } from "../ctx.ts";
import { AppError } from "../errors.ts";
import { cell, pick, readPath, table, truncated, type Column } from "../mcp/table.ts";
import { getProject } from "./projects.ts";

/**
 * Local SEO tools: Google Business Profile, reviews, posts, Q&A, business listings, local SERPs and the local rank grid.
 * Results are provider rows trimmed to the fields agents need, in the layout OpenSEO's agents already expect.
 */

type Args = Record<string, any>;
type Out = { data: Record<string, unknown>; text: string };

const coord = (v: number) => Number(v.toFixed(7)).toString();
const NO_RESULTS = /no search results/i;

/** One live call; DataForSEO's "no search results" is an empty success, not an error. */
async function live(ctx: Ctx, path: string, body: unknown) {
  try {
    const r = await ctx.dfs.first<{ items?: unknown[] | null; items_without_answers?: unknown[] | null; check_url?: string }>(path, body);
    return r.result;
  } catch (e) {
    if (e instanceof AppError && NO_RESULTS.test(e.message)) return null;
    throw e;
  }
}
const itemsOf = (r: { items?: unknown[] | null } | null): Record<string, unknown>[] => (Array.isArray(r?.items) ? (r!.items as Record<string, unknown>[]) : []);

// ---------------- identifiers and locations ----------------

/** Business Data takes the radius in metres (200–199999); fractional kilometres are fine here. */
export function businessCoordinate(near: { latitude: number; longitude: number; radiusKm?: number }) {
  const m = Math.min(199_999, Math.max(200, Math.round((near.radiusKm ?? 10) * 1000)));
  return `${coord(near.latitude)},${coord(near.longitude)},${m}`;
}
/** Business Listings rejects fractional radii, so it takes whole kilometres. */
const listingsCoordinate = (near: { latitude: number; longitude: number; radiusKm: number }) => `${coord(near.latitude)},${coord(near.longitude)},${Math.max(1, Math.round(near.radiusKm))}`;
const serpCoordinate = (near: { latitude: number; longitude: number; zoom?: number }) => `${coord(near.latitude)},${coord(near.longitude)}${near.zoom == null ? "" : `,${near.zoom}z`}`;

function identifier(a: Args) {
  const given = [a.businessName, a.cid, a.placeId].filter((v) => v != null);
  if (given.length !== 1) throw new AppError("VALIDATION_ERROR", "Provide exactly one business identifier: businessName, cid, or placeId.");
  return { keyword: a.businessName as string | undefined, cid: a.cid as string | undefined, placeId: a.placeId as string | undefined };
}
const identifierKeyword = (i: ReturnType<typeof identifier>) => (i.cid != null ? `cid:${i.cid}` : i.placeId != null ? `place_id:${i.placeId}` : (i.keyword ?? ""));

function location(a: Args, project: { locationCode: number; languageCode: string }) {
  return {
    ...(a.near ? { location_coordinate: businessCoordinate(a.near) } : { location_code: a.locationCode ?? project.locationCode }),
    language_code: a.languageCode ?? project.languageCode,
  };
}

// ---------------- business profile ----------------

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const clock = (span: unknown, k: "open" | "close") => {
  const h = readPath(span, k, "hour"), m = readPath(span, k, "minute");
  return typeof h !== "number" ? "?" : `${String(h).padStart(2, "0")}:${String(typeof m === "number" ? m : 0).padStart(2, "0")}`;
};
function timetable(p: Record<string, unknown>) {
  const t = readPath(p, "work_time", "work_hours", "timetable");
  if (t == null) return "—";
  return DAYS.map((d) => {
    const spans = readPath(t, d);
    return !Array.isArray(spans) || spans.length === 0 ? `${d.slice(0, 3)} closed` : `${d.slice(0, 3)} ${spans.map((s) => `${clock(s, "open")}-${clock(s, "close")}`).join(",")}`;
  }).join(" | ");
}
function ratingBreakdown(p: Record<string, unknown>) {
  const d = readPath(p, "rating_distribution");
  return d == null ? "—" : [5, 4, 3, 2, 1].map((s) => `${s}★ ${typeof readPath(d, String(s)) === "number" ? readPath(d, String(s)) : 0}`).join(", ");
}
function profileText(p: Record<string, unknown>) {
  const extra = readPath(p, "additional_categories");
  const category = cell(readPath(p, "category"));
  const rows: [string, string][] = [
    ["title", cell(readPath(p, "title"))],
    ["category", Array.isArray(extra) && extra.length > 0 ? `${category} (+ ${extra.map(cell).join(", ")})` : category],
    ["rating", `${cell(readPath(p, "rating", "value"))} from ${cell(readPath(p, "rating", "votes_count"))} reviews`],
    ["rating breakdown", ratingBreakdown(p)],
    ["address", cell(readPath(p, "address"))], ["phone", cell(readPath(p, "phone"))], ["website", cell(readPath(p, "url"))], ["domain", cell(readPath(p, "domain"))],
    ["claimed", cell(readPath(p, "is_claimed"))], ["status now", cell(readPath(p, "work_time", "work_hours", "current_status"))], ["hours", timetable(p)],
    ["photos", cell(readPath(p, "total_photos"))], ["cid", cell(readPath(p, "cid"))], ["place_id", cell(readPath(p, "place_id"))], ["check_url", cell(readPath(p, "check_url"))],
  ];
  return rows.map(([k, v]) => `- ${k}: ${v}`).join("\n");
}

export async function getBusinessProfile(ctx: Ctx, a: Args): Promise<Out> {
  const project = getProject(ctx, a.projectId);
  const id = identifier(a);
  const r = await live(ctx, "/v3/business_data/google/my_business_info/live", { keyword: identifierKeyword(id), ...location(a, project) });
  const item = r?.items?.[0];
  let profile: Record<string, unknown> | null = null;
  if (item && typeof item === "object") {
    profile = item as Record<string, unknown>;
    if (profile.check_url == null) profile.check_url = r?.check_url;
  }
  return {
    data: { profile },
    text: profile ? `Google Business Profile:\n${profileText(profile)}` : "No Google Business Profile matched that identifier. Try a cid or placeId from get_local_serp_results.",
  };
}

// ---------------- queued tasks: reviews and posts ----------------

type Endpoint = "reviews" | "extended_reviews" | "my_business_updates";
const IN_PROGRESS = new Set([20100, 40601, 40602]);
const POLL_ATTEMPTS = 6;

async function postTask(ctx: Ctx, endpoint: Endpoint, body: Record<string, unknown>): Promise<string> {
  const [t] = await ctx.dfs.post(`/v3/business_data/google/${endpoint}/task_post`, [{ ...body, priority: 2 }]);
  if (!t || t.statusCode !== 20100) {
    const code = t?.statusCode ?? 0, msg = t?.message || "DataForSEO task failed";
    if (code === 40201) throw new AppError("UPSTREAM_PAUSED", msg);
    if (code === 40101 || code === 40100) throw new AppError("UNAUTHENTICATED", msg);
    if (code === 40200 || code === 40202) throw new AppError("UPSTREAM_ERROR", msg);
    throw new AppError(code >= 50000 ? "UPSTREAM_UNAVAILABLE" : "INTERNAL_ERROR", msg);
  }
  if (!t.id) throw new AppError("INTERNAL_ERROR", "DataForSEO did not return a task id");
  return t.id;
}

type Outcome = { status: "pending" | "completed"; result: Record<string, unknown> | null };
async function collect(ctx: Ctx, endpoint: Endpoint, taskId: string): Promise<Outcome> {
  const r = await ctx.dfs.getTask<Record<string, unknown>>(`/v3/business_data/google/${endpoint}/task_get/${encodeURIComponent(taskId)}`);
  if (IN_PROGRESS.has(r.statusCode)) return { status: "pending", result: null };
  if (r.statusCode !== 20000) {
    if (!NO_RESULTS.test(r.message)) throw new AppError("INTERNAL_ERROR", r.message || `DataForSEO task failed (${r.statusCode})`);
    return { status: "completed", result: null };
  }
  return { status: "completed", result: r.result && typeof r.result === "object" ? r.result : null };
}

async function poll(ctx: Ctx, endpoint: Endpoint, taskId: string, publicId: string): Promise<Outcome> {
  try {
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, ctx.config.businessPollMs));
      const o = await collect(ctx, endpoint, taskId);
      if (o.status === "completed") return o;
    }
    return { status: "pending", result: null };
  } catch (e) {
    if (e instanceof AppError) throw new AppError(e.code, `${e.message} The queued task is still collectable — call again with taskId "${publicId}" at no extra cost.`);
    throw e;
  }
}

const REVIEW_FIELDS = ["rank_absolute", "time_ago", "timestamp", "rating", "review_text", "original_review_text", "original_language", "profile_name", "local_guide", "reviews_count", "photos_count", "review_highlights", "source", "owner_answer", "owner_time_ago", "owner_timestamp", "review_id"] as const;
const REVIEW_COLS: Column<unknown>[] = [
  { header: "#", value: (r) => readPath(r, "rank_absolute") },
  { header: "when", value: (r) => readPath(r, "time_ago") ?? readPath(r, "timestamp") },
  { header: "rating", value: (r) => readPath(r, "rating", "value") },
  { header: "author", value: (r) => readPath(r, "profile_name") },
  { header: "source", value: (r) => readPath(r, "source", "title") ?? "Google" },
  { header: "review", value: (r) => readPath(r, "review_text"), format: truncated(120) },
  { header: "owner replied", value: (r) => readPath(r, "owner_answer") != null },
];

export async function getBusinessReviews(ctx: Ctx, a: Args): Promise<Out> {
  const project = getProject(ctx, a.projectId);
  const other = a.includeOtherSources ?? false;
  let endpoint: Endpoint, taskId: string, publicId: string;
  if (a.taskId) {
    const m = /^(google|extended):(.+)$/.exec(a.taskId);
    if (!m) throw new AppError("VALIDATION_ERROR", 'taskId must be the value this tool returned, formatted as "google:<id>" or "extended:<id>".');
    endpoint = m[1] === "extended" ? "extended_reviews" : "reviews";
    taskId = m[2] ?? "";
    publicId = a.taskId;
  } else {
    const id = identifier(a);
    const base = { keyword: id.keyword, cid: id.cid, place_id: id.placeId, ...location(a, project), depth: a.depth ?? 20 };
    endpoint = other ? "extended_reviews" : "reviews";
    taskId = await postTask(ctx, endpoint, other ? base : { ...base, sort_by: a.sortBy ?? "newest" });
    publicId = `${other ? "extended" : "google"}:${taskId}`;
  }
  const o = await poll(ctx, endpoint, taskId, publicId);
  if (o.status === "pending") {
    return { data: { status: "processing", taskId: publicId }, text: `Review collection is still running. Call get_business_reviews again with taskId "${publicId}" in 30-60 seconds — resuming charges no extra credits.` };
  }
  const reviews = itemsOf(o.result as never).map((r) => pick(r, REVIEW_FIELDS));
  const totals = o.result ? { title: o.result.title ?? null, reviews_count: o.result.reviews_count ?? null, rating: o.result.rating ?? null, cid: o.result.cid ?? null, place_id: o.result.place_id ?? null } : null;
  const header = `Collected ${reviews.length} reviews${typeof totals?.reviews_count === "number" ? ` of ${totals.reviews_count} total` : ""}.`;
  return {
    data: { status: "completed", taskId: publicId, reviews, totals },
    text: reviews.length === 0 ? `${header} This profile has no reviews matching the request.` : `${header} Review text is truncated in this table; full text is in the structured result.\n${table(reviews, REVIEW_COLS)}`,
  };
}

const UPDATE_FIELDS = ["rank_absolute", "author", "post_date", "timestamp", "post_text", "snippet", "url", "links"] as const;
const UPDATE_COLS: Column<unknown>[] = [
  { header: "#", value: (r) => readPath(r, "rank_absolute") },
  { header: "posted", value: (r) => readPath(r, "post_date") ?? readPath(r, "timestamp") },
  { header: "post", value: (r) => readPath(r, "post_text") ?? readPath(r, "snippet"), format: truncated(120) },
  { header: "url", value: (r) => readPath(r, "url") },
];

export async function getBusinessUpdates(ctx: Ctx, a: Args): Promise<Out> {
  const project = getProject(ctx, a.projectId);
  let taskId: string;
  if (a.taskId) {
    if (a.taskId.includes(":")) throw new AppError("VALIDATION_ERROR", "That looks like a get_business_reviews taskId; pass the bare taskId this tool returned.");
    taskId = a.taskId;
  } else {
    const id = identifier(a);
    taskId = await postTask(ctx, "my_business_updates", { keyword: identifierKeyword(id), ...location(a, project), depth: a.depth ?? 10 });
  }
  const o = await poll(ctx, "my_business_updates", taskId, taskId);
  if (o.status === "pending") {
    return { data: { status: "processing", taskId }, text: `Post collection is still running. Call get_business_updates again with taskId "${taskId}" in 30-60 seconds — resuming charges no extra credits.` };
  }
  const updates = itemsOf(o.result as never).map((r) => pick(r, UPDATE_FIELDS));
  const header = `Collected ${updates.length} Google Business posts.`;
  return { data: { status: "completed", taskId, updates }, text: updates.length === 0 ? `${header} This profile has published no posts.` : `${header}\n${table(updates, UPDATE_COLS)}` };
}

// ---------------- categories ----------------

type Category = { category: string; businessCount: number | null };
const CAT_TTL_MS = 7 * 86_400_000;

export async function listBusinessCategories(ctx: Ctx, a: Args): Promise<Out> {
  getProject(ctx, a.projectId);
  const key = "local:business-categories";
  const hit = ctx.db.prepare("SELECT value FROM kv_cache WHERE key=? AND expires_at>?").get(key, Date.now()) as { value: string } | undefined;
  let all: Category[] | null = null;
  if (hit) { try { all = JSON.parse(hit.value) as Category[]; } catch { all = null; } }
  if (!all) {
    const r = await ctx.dfs.request<{ category_name?: unknown; business_count?: unknown }[]>("/v3/business_data/business_listings/categories");
    all = (r.result ?? []).flatMap((e) => (e && typeof e.category_name === "string" ? [{ category: e.category_name, businessCount: typeof e.business_count === "number" ? e.business_count : null }] : []));
    ctx.db.prepare("INSERT INTO kv_cache (key,value,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at").run(key, JSON.stringify(all), Date.now() + CAT_TTL_MS);
  }
  const q = typeof a.query === "string" ? a.query.toLowerCase() : undefined;
  const matched = q ? all.filter((r) => r.category.toLowerCase().includes(q)) : all;
  const categories = matched.slice(0, a.limit ?? 50);
  const header = `Found ${matched.length} categories${q ? ` matching "${a.query}"` : ""}; showing ${categories.length}.`;
  const cols: Column<Category>[] = [{ header: "category", value: (r) => r.category }, { header: "businesses", value: (r) => r.businessCount }];
  return { data: { categories }, text: categories.length === 0 ? header : `${header}\n${table(categories, cols)}` };
}

// ---------------- listings, local SERP, Q&A ----------------

const LISTING_FIELDS = ["title", "description", "category", "additional_categories", "address", "phone", "url", "domain", "rating", "is_claimed", "cid", "place_id", "latitude", "longitude", "total_photos", "check_url"] as const;
const LISTING_COLS: Column<unknown>[] = [
  { header: "title", value: (r) => readPath(r, "title") }, { header: "category", value: (r) => readPath(r, "category") },
  { header: "rating", value: (r) => readPath(r, "rating", "value") }, { header: "reviews", value: (r) => readPath(r, "rating", "votes_count") },
  { header: "phone", value: (r) => readPath(r, "phone") }, { header: "address", value: (r) => readPath(r, "address") },
];

export async function searchLocalBusinesses(ctx: Ctx, a: Args): Promise<Out> {
  getProject(ctx, a.projectId);
  const filters: unknown[] = [];
  const and = (c: unknown[]) => { if (filters.length) filters.push("and"); filters.push(c); };
  if (a.minRating != null) and(["rating.value", ">=", a.minRating]);
  if (a.minReviews != null) and(["rating.votes_count", ">=", a.minReviews]);
  const orderBy = a.sortBy === "rating" ? ["rating.value,desc"] : a.sortBy === "reviews" ? ["rating.votes_count,desc"] : undefined;
  const r = await live(ctx, "/v3/business_data/business_listings/search/live", {
    categories: a.categories, title: a.query, location_coordinate: listingsCoordinate(a.near), is_claimed: a.isClaimed,
    filters: filters.length ? filters : undefined, order_by: orderBy, limit: a.limit ?? 20, offset: a.offset,
  });
  const businesses = itemsOf(r).map((x) => pick(x, LISTING_FIELDS));
  const header = `Found ${businesses.length} local business rows${a.query ? ` for ${a.query}` : ""}.`;
  return { data: { businesses }, text: businesses.length === 0 ? header : `${header}\n${table(businesses, LISTING_COLS)}` };
}

const SERP_FIELDS = ["rank_group", "rank_absolute", "title", "domain", "url", "contact_url", "address", "address_info", "phone", "category", "additional_categories", "rating", "rating_distribution", "price_level", "is_claimed", "cid", "place_id", "latitude", "longitude", "total_photos", "work_hours", "local_justifications"] as const;
const SERP_COLS: Column<unknown>[] = [
  { header: "rank", value: (r) => readPath(r, "rank_absolute") ?? readPath(r, "rank_group") }, { header: "title", value: (r) => readPath(r, "title") },
  { header: "rating", value: (r) => readPath(r, "rating", "value") }, { header: "reviews", value: (r) => readPath(r, "rating", "votes_count") },
  { header: "phone", value: (r) => readPath(r, "phone") }, { header: "address", value: (r) => readPath(r, "address") },
];

async function localSerp(ctx: Ctx, i: { keyword: string; coordinate: string; languageCode: string; searchType: "maps" | "local_finder"; device: "desktop" | "mobile"; depth: number; searchPlaces?: boolean }) {
  const os = i.device === "desktop" ? "windows" : "android";
  const base = { keyword: i.keyword, location_coordinate: i.coordinate, language_code: i.languageCode, device: i.device, os, depth: i.depth };
  const r = i.searchType === "maps"
    ? await live(ctx, "/v3/serp/google/maps/live/advanced", { ...base, search_places: i.searchPlaces })
    : await live(ctx, "/v3/serp/google/local_finder/live/advanced", base);
  return itemsOf(r);
}

export async function getLocalSerpResults(ctx: Ctx, a: Args): Promise<Out> {
  const project = getProject(ctx, a.projectId);
  const rows = await localSerp(ctx, { keyword: a.keyword, coordinate: serpCoordinate(a.near), languageCode: a.languageCode ?? project.languageCode, searchType: a.searchType ?? "maps", device: a.device ?? "mobile", depth: a.depth ?? 20, searchPlaces: false });
  const results = rows.map((x) => pick(x, SERP_FIELDS));
  const header = `Fetched ${results.length} local SERP rows for "${a.keyword}".`;
  return { data: { results }, text: results.length === 0 ? header : `${header}\n${table(results, SERP_COLS)}` };
}

const QA_FIELDS = ["rank_absolute", "question_id", "question_text", "original_question_text", "profile_name", "time_ago", "timestamp"] as const;
const ANSWER_FIELDS = ["answer_id", "answer_text", "original_answer_text", "profile_name", "time_ago", "timestamp"] as const;
const QA_COLS: Column<unknown>[] = [
  { header: "question", value: (r) => readPath(r, "question_text") }, { header: "asked by", value: (r) => readPath(r, "profile_name") }, { header: "when", value: (r) => readPath(r, "time_ago") },
  { header: "answers", value: (r) => { const x = readPath(r, "items"); return Array.isArray(x) ? x.length : 0; } },
];

export async function getGoogleBusinessQuestions(ctx: Ctx, a: Args): Promise<Out> {
  const project = getProject(ctx, a.projectId);
  const id = identifier(a);
  const r = await live(ctx, "/v3/business_data/google/questions_and_answers/live", { keyword: identifierKeyword(id), location_coordinate: businessCoordinate(a.near), language_code: a.languageCode ?? project.languageCode, depth: a.depth ?? 20 });
  const rows = [...(Array.isArray(r?.items) ? r!.items : []), ...(Array.isArray(r?.items_without_answers) ? r!.items_without_answers : [])] as Record<string, unknown>[];
  const questions = rows.map((row) => {
    const t = pick(row, QA_FIELDS);
    const answers = readPath(row, "items");
    t.items = Array.isArray(answers) ? answers.map((x) => pick(x, ANSWER_FIELDS)) : null;
    return t;
  });
  const header = `Fetched ${questions.length} Google Business Q&A rows for ${identifierKeyword(id)}.`;
  return { data: { questions }, text: questions.length === 0 ? header : `${header}\n${table(questions, QA_COLS)}` };
}

// ---------------- local rank grid ----------------

const KM_LAT = 110.574, KM_LON = 111.32, MIN_COS = 0.01, GRID_DEPTH = 20, GRID_CONCURRENCY = 3;
const cosLat = (lat: number) => Math.max(Math.abs(Math.cos((lat * Math.PI) / 180)), MIN_COS);
const gridZoom = (spacingKm: number, lat: number) => Math.min(18, Math.max(4, Math.floor(Math.log2((24045 * cosLat(lat)) / spacingKm))));

type Point = { row: number; col: number; latitude: number; longitude: number };
type PointResult = Point & { rank: number | null; resultsCount?: number; topResult?: { title: string | null; cid: string | null } | null; error?: boolean };

function gridPoints(center: { latitude: number; longitude: number }, size: number, spacingKm: number): Point[] {
  const mid = (size - 1) / 2, dLat = spacingKm / KM_LAT, dLon = spacingKm / (KM_LON * cosLat(center.latitude));
  const out: Point[] = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) out.push({ row, col, latitude: Number((center.latitude + (mid - row) * dLat).toFixed(7)), longitude: Number((center.longitude + (col - mid) * dLon).toFixed(7)) });
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const ABORT = new Set(["UNAUTHENTICATED", "NOT_CONFIGURED", "BUDGET_EXCEEDED", "UPSTREAM_PAUSED", "UPSTREAM_BILLING"]);

export async function getLocalRankGrid(ctx: Ctx, a: Args): Promise<Out> {
  const project = getProject(ctx, a.projectId);
  const t = a.target ?? {};
  if (t.cid == null && t.placeId == null && t.name == null) throw new AppError("VALIDATION_ERROR", "target needs at least one of cid, placeId, or name.");
  const size: number = a.gridSize ?? 3, spacing: number = a.spacingKm ?? 2;
  const zoom: number = a.zoom ?? gridZoom(spacing, a.center.latitude);
  const points = gridPoints(a.center, size, spacing);
  const lang = a.languageCode ?? project.languageCode;
  let matched: { title: string | null; cid: string | null; placeId: string | null } | null = null;
  let lastError: unknown = null;
  const name = typeof t.name === "string" ? t.name.toLowerCase() : undefined;

  const search = async (p: Point): Promise<PointResult> => {
    try {
      const items = await localSerp(ctx, { keyword: a.keyword, coordinate: serpCoordinate({ ...p, zoom }), languageCode: lang, searchType: "maps", device: a.device ?? "mobile", depth: GRID_DEPTH, searchPlaces: false });
      const m = items.find((it) => (t.cid != null && readPath(it, "cid") === t.cid) || (t.placeId != null && readPath(it, "place_id") === t.placeId) || (name != null && typeof readPath(it, "title") === "string" && (readPath(it, "title") as string).toLowerCase().includes(name)));
      if (m && !matched) matched = { title: str(readPath(m, "title")), cid: str(readPath(m, "cid")), placeId: str(readPath(m, "place_id")) };
      const rank = readPath(m, "rank_absolute") ?? readPath(m, "rank_group");
      const first = items[0];
      return { ...p, rank: typeof rank === "number" ? rank : null, resultsCount: items.length, topResult: first == null ? null : { title: str(readPath(first, "title")), cid: str(readPath(first, "cid")) } };
    } catch (e) {
      if (e instanceof AppError && ABORT.has(e.code)) throw e;
      lastError = e;
      return { ...p, rank: null, error: true };
    }
  };

  const grid: PointResult[] = [];
  for (let i = 0; i < points.length; i += GRID_CONCURRENCY) grid.push(...(await Promise.all(points.slice(i, i + GRID_CONCURRENCY).map(search))));
  if (grid.every((p) => p.error)) throw lastError;

  const found = grid.filter((p) => p.rank != null);
  const ranks = found.map((p) => p.rank ?? 0);
  const summary = {
    pointsSearched: grid.length, pointsFound: found.length,
    averageRank: ranks.length ? Number((ranks.reduce((s, r) => s + r, 0) / ranks.length).toFixed(2)) : null,
    top3Count: ranks.filter((r) => r <= 3).length, top10Count: ranks.filter((r) => r <= 10).length,
  };
  const lines: string[] = [];
  for (let row = 0; row < size; row++) lines.push(grid.slice(row * size, (row + 1) * size).map((p) => (p.error ? "x" : (p.rank?.toString() ?? "–")).padStart(2, " ")).join(" "));
  const text = [
    `Local rank grid for "${a.keyword}" (${size}x${size}, ${spacing} km spacing, zoom ${zoom}, top ${GRID_DEPTH} checked).`,
    `Rank per point, north at the top ("–" = not among the results returned there; check that point's resultsCount and topResult before reading it as outranked, "x" = search failed but may still be charged):`,
    lines.join("\n"),
    `- ranked at ${summary.pointsFound} of ${summary.pointsSearched} points`,
    `- average rank where found: ${summary.averageRank ?? "—"}`,
    `- top 3 at ${summary.top3Count} points, top 10 at ${summary.top10Count} points`,
  ].join("\n");
  return { data: { grid, summary, matchedBusiness: matched }, text };
}
