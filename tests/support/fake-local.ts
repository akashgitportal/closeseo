/** Deterministic stand-ins for DataForSEO Business Data and Maps SERP endpoints (shared by the fake server). */
type Body = Record<string, any>;
type Reply = { result?: unknown; cost?: number; error?: { code: number; message: string }; raw?: unknown } | null;

const hash = (s: string) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

const BUSINESSES = [
  { title: "Joe's Pizza", cid: "111", place_id: "ChIJ-joes", category: "pizza_restaurant", rating: 4.6, votes: 820, claimed: true, phone: "+1 555 0101", domain: "joespizza.example" },
  { title: "Slice Heaven", cid: "222", place_id: "ChIJ-slice", category: "pizza_restaurant", rating: 4.1, votes: 95, claimed: false, phone: "+1 555 0102", domain: "sliceheaven.example" },
  { title: "Pipe Masters Plumbing", cid: "333", place_id: "ChIJ-pipes", category: "plumber", rating: 3.8, votes: 41, claimed: true, phone: "+1 555 0103", domain: "pipemasters.example" },
  { title: "Corner Bakery", cid: "444", place_id: "ChIJ-bakery", category: "bakery", rating: 4.9, votes: 1500, claimed: false, phone: "+1 555 0104", domain: "cornerbakery.example" },
  { title: "Pizza Planet", cid: "555", place_id: "ChIJ-planet", category: "pizza_restaurant", rating: 3.2, votes: 12, claimed: false, phone: null, domain: null },
];
const listing = (b: (typeof BUSINESSES)[number]) => ({
  type: "business_listing", title: b.title, description: `${b.title} description`, category: b.category, additional_categories: b.category === "pizza_restaurant" ? ["restaurant"] : null,
  address: `${b.cid} Main St`, phone: b.phone, url: b.domain ? `https://${b.domain}/` : null, domain: b.domain, rating: { rating_type: "Max5", value: b.rating, votes_count: b.votes, rating_max: 5 },
  is_claimed: b.claimed, cid: b.cid, place_id: b.place_id, latitude: 40.7, longitude: -74, total_photos: 10 + Number(b.cid[0]), check_url: `https://www.google.com/maps?cid=${b.cid}`, price_level: "inexpensive", ignored_provider_field: true,
});

const tasks = new Map<string, { at: number; kind: string; body: Body }>();
let taskReadyMs = 0;
let neverReady = false;
export const localControl = (b: { taskReadyMs?: number; neverReady?: boolean }) => { if (b.taskReadyMs !== undefined) taskReadyMs = b.taskReadyMs; if (b.neverReady !== undefined) neverReady = b.neverReady; };

const find = (kw: string) => BUSINESSES.find((b) => kw === `cid:${b.cid}` || kw === `place_id:${b.place_id}` || b.title.toLowerCase() === kw.toLowerCase());

function reviewsFor(body: Body, extended: boolean) {
  const b = find(String(body.keyword ?? (body.cid ? `cid:${body.cid}` : `place_id:${body.place_id}`)));
  if (!b) return null;
  const depth = Number(body.depth ?? 20);
  const items = Array.from({ length: Math.min(depth, 12) }, (_, i) => ({
    type: extended ? "extended_reviews_element" : "google_reviews_search", rank_absolute: i + 1, time_ago: `${i + 1} weeks ago`, timestamp: `2026-0${(i % 9) + 1}-01 10:00:00 +00:00`, rating: { value: 5 - (i % 5), votes_count: null },
    review_text: i === 2 ? "Long review. ".repeat(30) : `Review number ${i + 1} for ${b.title}`, profile_name: `Reviewer ${i + 1}`, owner_answer: i % 3 === 0 ? "Thanks!" : null, source: extended ? { title: i % 2 ? "Yelp" : "Tripadvisor" } : undefined, extra_noise: "x",
  }));
  return { keyword: b.title, title: b.title, cid: b.cid, place_id: b.place_id, rating: { value: b.rating, votes_count: b.votes }, reviews_count: b.votes, items_count: items.length, items };
}

export function fakeLocal(path: string, body: Body, method: string): Reply {
  if (path === "/v3/business_data/business_listings/categories") {
    return { cost: 0, result: [{ category_name: "pizza_restaurant", business_count: 5000 }, { category_name: "plumber", business_count: 3000 }, { category_name: "pizza_delivery", business_count: 400 }, { category_name: "bakery", business_count: 1200 }, { bogus: true }] };
  }
  if (path === "/v3/business_data/business_listings/search/live") {
    if (String(body.title ?? "") === "nothing-here") return { error: { code: 40501, message: "No Search Results." } };
    if (String(body.title ?? "") === "bad-coordinate") return { error: { code: 40501, message: "Invalid Field: 'location_coordinate'." } };
    let rows = BUSINESSES.filter((b) => (!body.title || b.title.toLowerCase().includes(String(body.title).toLowerCase())) && (!body.categories || (body.categories as string[]).includes(b.category)) && (body.is_claimed === undefined || b.claimed === body.is_claimed));
    for (const f of (body.filters ?? []) as unknown[]) if (Array.isArray(f)) { const [field, , v] = f as [string, string, number]; rows = rows.filter((b) => (field === "rating.value" ? b.rating : b.votes) >= v); }
    const ord = (body.order_by as string[] | undefined)?.[0];
    if (ord === "rating.value,desc") rows = [...rows].sort((a, b) => b.rating - a.rating);
    if (ord === "rating.votes_count,desc") rows = [...rows].sort((a, b) => b.votes - a.votes);
    const off = Number(body.offset ?? 0), lim = Number(body.limit ?? 20);
    const page = rows.slice(off, off + lim).map(listing);
    return { cost: 0.01 + page.length * 0.0001, result: { total_count: rows.length, count: page.length, items: page } };
  }
  if (path === "/v3/business_data/google/my_business_info/live") {
    const b = find(String(body.keyword ?? ""));
    if (!b) return { error: { code: 40501, message: "No Search Results." } };
    return { cost: 0.0054, result: { keyword: body.keyword, check_url: `https://google.com/search?q=${b.cid}`, items_count: 1, items: [{ type: "google_business_info", title: b.title, category: b.category, additional_categories: ["restaurant"], rating: { value: b.rating, votes_count: b.votes }, rating_distribution: { "1": 3, "2": 2, "3": 5, "4": 20, "5": 70 }, address: `${b.cid} Main St`, phone: b.phone, url: b.domain ? `https://${b.domain}/` : null, domain: b.domain, is_claimed: b.claimed, total_photos: 42, cid: b.cid, place_id: b.place_id, work_time: { work_hours: { current_status: "open", timetable: { monday: [{ open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 30 } }], tuesday: [{ open: { hour: 9, minute: 0 }, close: { hour: 12, minute: 0 } }, { open: { hour: 13, minute: 0 }, close: { hour: 17, minute: 0 } }], wednesday: null, thursday: [], friday: [{ open: { hour: 9 }, close: { hour: 17 } }], saturday: null, sunday: null } } } }] } };
  }
  if (path === "/v3/business_data/google/questions_and_answers/live") {
    const b = find(String(body.keyword ?? ""));
    if (!b) return { error: { code: 40501, message: "No Search Results." } };
    return { cost: 0.0033, result: [{ keyword: b.title, items: [{ rank_absolute: 1, question_id: "q1", question_text: "Do you deliver?", original_question_text: "Do you deliver?", profile_name: "Ann", time_ago: "2 months ago", timestamp: "2026-01-01 00:00:00 +00:00", items: [{ answer_id: "a1", answer_text: "Yes!", profile_name: "Owner", time_ago: "2 months ago", timestamp: "2026-01-02 00:00:00 +00:00", noise: 1 }] }], items_without_answers: [{ rank_absolute: 2, question_id: "q2", question_text: "Parking?", profile_name: "Bob", time_ago: "1 week ago", items: null }] }] };
  }
  const post = /^\/v3\/business_data\/google\/(reviews|extended_reviews|my_business_updates)\/task_post$/.exec(path);
  if (post) return { raw: true, result: post[1] };
  const get = /^\/v3\/business_data\/google\/(reviews|extended_reviews|my_business_updates)\/task_get\/(.+)$/.exec(path);
  if (get && method === "GET") {
    const t = tasks.get(decodeURIComponent(get[2]!));
    if (!t) return { error: { code: 40400, message: "Not Found." } };
    if (neverReady || Date.now() - t.at < taskReadyMs) return { error: { code: 40602, message: "Task In Queue." } };
    if (t.kind === "my_business_updates") {
      const b = find(String(t.body.keyword ?? ""));
      if (!b) return { error: { code: 40501, message: "No Search Results." } };
      const n = b.cid === "222" ? 0 : 3;
      return { cost: 0, result: { keyword: b.title, items_count: n, items: Array.from({ length: n }, (_, i) => ({ type: "google_business_updates_element", rank_absolute: i + 1, author: b.title, post_date: `2026-0${i + 1}-01`, timestamp: `2026-0${i + 1}-01 00:00:00 +00:00`, post_text: `Post ${i + 1}`, snippet: "snip", url: `https://posts.example/${i}`, links: [{ text: "x" }], noise: 1 })) } };
    }
    const res = reviewsFor(t.body, t.kind === "extended_reviews");
    if (!res) return { error: { code: 40501, message: "No Search Results." } };
    return { cost: 0, result: res };
  }
  const serp = /^\/v3\/serp\/google\/(maps|local_finder)\/live\/advanced$/.exec(path);
  if (serp) {
    const coordinate = String(body.location_coordinate ?? "");
    if (String(body.keyword).includes("[serpfail]")) return { error: { code: 50000, message: "Internal Error." } };
    const lat = Number(coordinate.split(",")[0]);
    if (String(body.keyword).includes("[nothing]")) return { error: { code: 40501, message: "No Search Results." } };
    // Joe's Pizza rank depends on the point; far-north points do not list it at all.
    const base = hash(coordinate) % 7;
    const items = BUSINESSES.map((b, i) => ({ type: serp[1] === "maps" ? "maps_search" : "local_pack", rank_group: i + 1, rank_absolute: i + 1, title: b.title, domain: b.domain, url: b.domain ? `https://${b.domain}/` : null, address: `${b.cid} Main St`, phone: b.phone, category: b.category, rating: { value: b.rating, votes_count: b.votes }, is_claimed: b.claimed, cid: b.cid, place_id: b.place_id, latitude: 40.7, longitude: -74, total_photos: 3, work_hours: null }));
    const rotated = [...items.slice(base % items.length), ...items.slice(0, base % items.length)].map((it, i) => ({ ...it, rank_group: i + 1, rank_absolute: i + 1 }));
    const out = lat > 40.75 ? rotated.filter((it) => it.cid !== "111") : rotated;
    return { cost: 0.002, result: { keyword: body.keyword, type: serp[1], items_count: out.length, items: out } };
  }
  return null;
}

/** Called by the fake server when a task is created, so task_get can find it. */
export function rememberTask(kind: string, id: string, body: Body) { tasks.set(id, { at: Date.now(), kind, body }); }
