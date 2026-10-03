/** Published DataForSEO prices for Google organic SERP calls; rank-check estimates are built from these. */
const LIVE_FIRST_PAGE_USD = 0.002;
const LIVE_EXTRA_PAGE_USD = 0.0015;
const QUEUED_FIRST_PAGE_USD = 0.0006;
const QUEUED_EXTRA_PAGE_USD = 0.00045;
export const MAX_TASKS_PER_POST = 100;
export const CREDITS_PER_USD = 1000;

export type RankCheckMethod = "live" | "queued";
export type Devices = "desktop" | "mobile" | "both";
export const devicesCount = (d: Devices) => (d === "both" ? 2 : 1);

/** Price of one SERP request for `depth` results (ten per page). */
export function costPerSerpAtDepth(depth: number, method: RankCheckMethod): number {
  const pages = depth / 10;
  return method === "queued" ? QUEUED_FIRST_PAGE_USD + (pages - 1) * QUEUED_EXTRA_PAGE_USD : LIVE_FIRST_PAGE_USD + (pages - 1) * LIVE_EXTRA_PAGE_USD;
}

// A keyword containing a search operator is billed five times over. The pattern may match loosely; the worst case is a high estimate.
const OPERATOR = /(allinanchor|allintext|allintitle|allinurl|cache|define|definition|filetype|id|inanchor|info|intext|intitle|inurl|link|site):/i;
export const keywordCostMultiplier = (keyword: string) => (OPERATOR.test(keyword) ? 5 : 1);

export const roundUsd = (v: number) => Math.round(v * 100000) / 100000;

/**
 * Cost estimate in USD and in credits. Credits are rounded up for each provider call (live: one call per keyword and
 * device; queued: one call per batch of up to 100 checks) so rounding once overall can never undercount.
 * `markup` stays at 1 when you self-host and pay DataForSEO directly; CREDIT_MARKUP can model a reseller margin.
 */
export function estimateRankCheck(keywords: readonly string[], devices: Devices, depth: number, method: RankCheckMethod, markup = 1) {
  const multipliers = keywords.flatMap((k) => Array<number>(devicesCount(devices)).fill(keywordCostMultiplier(k)));
  const perCall = method === "queued" ? MAX_TASKS_PER_POST : 1;
  let usd = 0, credits = 0;
  for (let i = 0; i < multipliers.length; i += perCall) {
    const raw = multipliers.slice(i, i + perCall).reduce((a, b) => a + b, 0) * costPerSerpAtDepth(depth, method);
    const marked = roundUsd(raw * markup);
    usd += marked;
    credits += Math.ceil(marked * CREDITS_PER_USD);
  }
  return { costUsd: roundUsd(usd), costCredits: credits };
}

export function estimateScheduled(keywords: readonly string[], devices: Devices, depth: number, interval: "daily" | "weekly" | "monthly", markup = 1) {
  const { costUsd, costCredits } = estimateRankCheck(keywords, devices, depth, "queued", markup);
  const checksPerMonth = interval === "daily" ? 30 : interval === "weekly" ? 4 : 1;
  return { scheduleInterval: interval, costUsd, costCredits, checksPerMonth, monthlyCostUsd: costUsd * checksPerMonth, monthlyCostCredits: costCredits * checksPerMonth };
}
