export type AuthMode = "local_noauth" | "api_key";

export type Config = {
  port: number;
  host: string;
  authMode: AuthMode;
  apiKey: string | null;
  databasePath: string;
  dataforseoKey: string | null;
  dataforseoBaseUrl: string;
  openrouterKey: string | null;
  openrouterModel: string;
  openrouterBaseUrl: string;
  /** Most model calls in one assistant turn. */
  agentMaxSteps: number;
  /** Hard stop for the spend of one assistant turn, in USD. */
  agentMaxCostUsd: number;
  /** Most paid data-provider tool calls in one assistant turn. */
  agentMaxPaidCalls: number;
  publicUrl: string | null;
  disableScheduler: boolean;
  allowPrivateAuditTargets: boolean;
  /** Multiplier applied to rank-check cost estimates (1 = raw DataForSEO price). */
  creditMarkup: number;
  /** Wait before retrying a call DataForSEO refused with a temporary "access paused" notice (x attempt number). */
  dfsRetryDelayMs: number;
  /** Google OAuth client for Search Console / Analytics (both required together with appSecret). */
  googleClientId: string | null;
  googleClientSecret: string | null;
  /** Secret (>= 32 chars) that encrypts stored Google tokens. */
  appSecret: string | null;
  /** Test seam: route every Google API host through this origin as "<origin>/<host>/...". */
  googleApiOrigin: string | null;
  googleAuthUrl: string;
  googleTokenUrl: string;
  /** Public report share links (/s/:token). Off by default. */
  enablePublicSharing: boolean;
  /** Delay between polls of queued SERP tasks. */
  rankPollMs: number;
  /** Delay between checks of a queued Google Business task (reviews, posts) inside one tool call. */
  businessPollMs: number;
  /** Give up on a queued SERP task after this long and fall back to a live check. */
  rankQueueTimeoutMs: number;
};

function positive(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} needs a number above zero, but received "${v}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.AUTH_MODE ?? "local_noauth") as string;
  if (mode !== "local_noauth" && mode !== "api_key") {
    throw new Error(
      `AUTH_MODE can only be "local_noauth" or "api_key"; received "${mode}"`,
    );
  }
  if (mode === "api_key" && !env.CLOSESEO_API_KEY) {
    throw new Error("With AUTH_MODE=api_key you also have to set CLOSESEO_API_KEY");
  }
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT has to be a whole number from 1 to 65535, but received "${env.PORT}"`);
  }
  if (env.CLOSESEO_SECRET && env.CLOSESEO_SECRET.trim().length < 32) throw new Error("CLOSESEO_SECRET needs at least 32 characters");
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    authMode: mode,
    apiKey: env.CLOSESEO_API_KEY ?? null,
    databasePath: env.DATABASE_PATH ?? "data/closeseo.db",
    dataforseoKey: env.DATAFORSEO_API_KEY || null,
    dataforseoBaseUrl: env.DATAFORSEO_BASE_URL ?? "https://api.dataforseo.com",
    openrouterKey: env.OPENROUTER_API_KEY || null,
    openrouterModel: env.OPENROUTER_MODEL?.trim() || "openai/gpt-4o-mini",
    openrouterBaseUrl: (env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    agentMaxSteps: positive(env.AGENT_MAX_STEPS, 8, "AGENT_MAX_STEPS"),
    agentMaxCostUsd: positive(env.AGENT_MAX_COST_USD, 0.25, "AGENT_MAX_COST_USD"),
    agentMaxPaidCalls: positive(env.AGENT_MAX_PAID_CALLS, 6, "AGENT_MAX_PAID_CALLS"),
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, "") || null,
    disableScheduler: env.DISABLE_SCHEDULER === "1",
    allowPrivateAuditTargets: env.ALLOW_PRIVATE_AUDIT_TARGETS === "1",
    enablePublicSharing: env.ENABLE_PUBLIC_SHARING === "1",
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || null,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || null,
    appSecret: env.CLOSESEO_SECRET?.trim() || null,
    googleApiOrigin: env.GOOGLE_API_ORIGIN?.replace(/\/+$/, "") || null,
    googleAuthUrl: env.GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
    googleTokenUrl: env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
    dfsRetryDelayMs: positive(env.DFS_RETRY_DELAY_MS, 3000, "DFS_RETRY_DELAY_MS"),
    creditMarkup: positive(env.CREDIT_MARKUP, 1, "CREDIT_MARKUP"),
    rankPollMs: positive(env.RANK_POLL_MS, 5000, "RANK_POLL_MS"),
    businessPollMs: positive(env.BUSINESS_POLL_MS, 4000, "BUSINESS_POLL_MS"),
    rankQueueTimeoutMs: positive(env.RANK_QUEUE_TIMEOUT_MS, 600_000, "RANK_QUEUE_TIMEOUT_MS"),
  };
}
