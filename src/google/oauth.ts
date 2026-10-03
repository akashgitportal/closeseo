import { createHash, randomBytes } from "node:crypto";
import type { Ctx } from "../ctx.ts";
import { newId, nowIso } from "../db.ts";
import { AppError } from "../errors.ts";
import { decrypt, encrypt } from "./crypto.ts";

export type GoogleProvider = "gsc" | "ga4";

export const PROVIDERS: Record<GoogleProvider, { name: string; scopes: string[]; required: string; callbackPath: string }> = {
  gsc: { name: "Search Console", scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/webmasters.readonly"], required: "https://www.googleapis.com/auth/webmasters.readonly", callbackPath: "/api/gsc/oauth/callback" },
  ga4: { name: "Google Analytics", scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/analytics.readonly"], required: "https://www.googleapis.com/auth/analytics.readonly", callbackPath: "/api/ga4/oauth/callback" },
};

export class GoogleTokenError extends Error {
  detail?: unknown;
  constructor(message: string, detail?: unknown) { super(message); this.name = "GoogleTokenError"; this.detail = detail; }
}

const STATE_TTL_MS = 10 * 60_000;
const SKEW_MS = 5_000;
const b64u = (b: Buffer) => b.toString("base64url");

/** Google features need an OAuth client and a secret to encrypt stored tokens. */
export function googleConfigured(ctx: Ctx): boolean {
  const c = ctx.config;
  return Boolean(c.googleClientId && c.googleClientSecret && c.appSecret && c.appSecret.length >= 32);
}

export function assertGoogleConfigured(ctx: Ctx) {
  if (!googleConfigured(ctx))
    throw new AppError("NOT_CONFIGURED", "Google integrations need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and CLOSESEO_SECRET (at least 32 characters).");
}

/** Map a Google API host to its base URL (rerouted through one origin in tests). */
export function apiBase(ctx: Ctx, host: string): string {
  return ctx.config.googleApiOrigin ? `${ctx.config.googleApiOrigin}/${host}` : `https://${host}`;
}

/** Build the consent URL. State is single-use, expires in 10 minutes and is bound to a project and provider; PKCE (S256) is always on. */
export function startAuthorization(ctx: Ctx, provider: GoogleProvider, projectId: string, publicOrigin: string): { url: string } {
  assertGoogleConfigured(ctx);
  if (!ctx.db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new AppError("NOT_FOUND", "NOT_FOUND");
  ctx.db.prepare("DELETE FROM google_oauth_states WHERE expires_at < ?").run(Date.now());
  const state = b64u(randomBytes(32));
  const verifier = b64u(randomBytes(48));
  const redirectUri = `${publicOrigin}${PROVIDERS[provider].callbackPath}`;
  ctx.db.prepare("INSERT INTO google_oauth_states (state,provider,project_id,code_verifier,redirect_uri,expires_at) VALUES (?,?,?,?,?,?)").run(state, provider, projectId, verifier, redirectUri, Date.now() + STATE_TTL_MS);
  const u = new URL(ctx.config.googleAuthUrl);
  u.searchParams.set("client_id", ctx.config.googleClientId!);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", PROVIDERS[provider].scopes.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "select_account consent");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", b64u(createHash("sha256").update(verifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  return { url: u.toString() };
}

type TokenResponse = { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };

async function tokenRequest(ctx: Ctx, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(ctx.config.googleTokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ctx.config.googleClientId!, client_secret: ctx.config.googleClientSecret!, ...params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) throw new GoogleTokenError(body.error_description ?? body.error ?? `Google token endpoint returned HTTP ${res.status}`, body.error);
  return body;
}

export type CallbackResult = { provider: GoogleProvider; projectId: string; grantId: string; email: string | null };

/** Finish consent: consume the state (one use only), exchange the code, verify the scope, store the encrypted grant. */
export async function completeAuthorization(ctx: Ctx, provider: GoogleProvider, params: { code: string | null; state: string | null }): Promise<CallbackResult> {
  assertGoogleConfigured(ctx);
  if (!params.state || !params.code) throw new AppError("VALIDATION_ERROR", "Missing code or state");
  const row = ctx.db.prepare("DELETE FROM google_oauth_states WHERE state=? AND provider=? AND expires_at > ? RETURNING project_id, code_verifier, redirect_uri").get(params.state, provider, Date.now()) as
    | { project_id: string; code_verifier: string; redirect_uri: string } | undefined;
  if (!row) throw new AppError("VALIDATION_ERROR", "This sign-in link is invalid, already used, or expired. Start the connection again.");
  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest(ctx, { grant_type: "authorization_code", code: params.code, redirect_uri: row.redirect_uri, code_verifier: row.code_verifier });
  } catch (e) {
    throw new AppError("UPSTREAM_ERROR", `Google refused the sign-in: ${(e as Error).message}`);
  }
  const granted = (tokens.scope ?? "").split(/\s+/);
  if (tokens.scope && !granted.includes(PROVIDERS[provider].required))
    throw new AppError("VALIDATION_ERROR", `${PROVIDERS[provider].name} access was not granted. Tick the permission box on Google's consent screen and try again.`);
  const info = await userInfo(ctx, tokens.access_token!);
  const secret = ctx.config.appSecret!;
  const now = nowIso();
  const id = newId();
  ctx.db.prepare(
    `INSERT INTO google_grants (id,provider,account_id,email,access_token_enc,refresh_token_enc,expires_at,scope,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(provider,account_id) DO UPDATE SET email=excluded.email, access_token_enc=excluded.access_token_enc,
       refresh_token_enc=COALESCE(excluded.refresh_token_enc, google_grants.refresh_token_enc), expires_at=excluded.expires_at, scope=excluded.scope, updated_at=excluded.updated_at`,
  ).run(id, provider, info.sub, info.email, encrypt(secret, tokens.access_token!), tokens.refresh_token ? encrypt(secret, tokens.refresh_token) : null, Date.now() + (tokens.expires_in ?? 3600) * 1000, tokens.scope ?? PROVIDERS[provider].scopes.join(" "), now, now);
  const grant = ctx.db.prepare("SELECT id FROM google_grants WHERE provider=? AND account_id=?").get(provider, info.sub) as { id: string };
  return { provider, projectId: row.project_id, grantId: grant.id, email: info.email };
}

async function userInfo(ctx: Ctx, accessToken: string): Promise<{ sub: string; email: string | null }> {
  const res = await fetch(`${apiBase(ctx, "openidconnect.googleapis.com")}/v1/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new AppError("UPSTREAM_ERROR", "Could not read the Google account profile");
  const j = (await res.json()) as { sub?: string; email?: string };
  if (!j.sub) throw new AppError("UPSTREAM_ERROR", "Google did not return an account id");
  return { sub: j.sub, email: j.email ?? null };
}

const refreshing = new Map<string, Promise<string>>();

/** A valid access token for a grant, refreshed (and re-stored) when it is about to expire. Concurrent callers share one refresh. */
export function getAccessToken(ctx: Ctx, grantId: string): Promise<string> {
  const row = ctx.db.prepare("SELECT access_token_enc, refresh_token_enc, expires_at FROM google_grants WHERE id=?").get(grantId) as
    | { access_token_enc: string; refresh_token_enc: string | null; expires_at: number } | undefined;
  if (!row) return Promise.reject(new GoogleTokenError("The Google connection no longer exists."));
  const secret = ctx.config.appSecret;
  if (!secret) return Promise.reject(new GoogleTokenError("CLOSESEO_SECRET is not set, so stored Google tokens cannot be read."));
  try {
    if (row.expires_at - SKEW_MS > Date.now()) return Promise.resolve(decrypt(secret, row.access_token_enc));
  } catch (e) {
    return Promise.reject(new GoogleTokenError("Stored Google tokens cannot be decrypted (was CLOSESEO_SECRET changed?).", e));
  }
  if (!row.refresh_token_enc) return Promise.reject(new GoogleTokenError("The Google connection expired and has no refresh token. Reconnect it."));
  const inflight = refreshing.get(grantId);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const t = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: decrypt(secret, row.refresh_token_enc!) });
      ctx.db.prepare("UPDATE google_grants SET access_token_enc=?, expires_at=?, refresh_token_enc=COALESCE(?, refresh_token_enc), updated_at=? WHERE id=?")
        .run(encrypt(secret, t.access_token!), Date.now() + (t.expires_in ?? 3600) * 1000, t.refresh_token ? encrypt(secret, t.refresh_token) : null, nowIso(), grantId);
      return t.access_token!;
    } catch (e) {
      throw new GoogleTokenError(`Google refused to refresh the connection${e instanceof Error ? ` (${e.message})` : ""}. Reconnect it.`, e);
    } finally { refreshing.delete(grantId); }
  })();
  refreshing.set(grantId, p);
  return p;
}

export class GoogleApiError extends Error {
  status: number; body: string; retryAfterSeconds: number | null;
  constructor(status: number, message: string, body = "", retryAfterSeconds: number | null = null) {
    super(message); this.name = "GoogleApiError"; this.status = status; this.body = body; this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Authenticated JSON call to a Google API. Non-2xx responses become GoogleApiError with the status and body. */
export async function googleJson<T>(ctx: Ctx, grantId: string, url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = await getAccessToken(ctx, grantId);
  const hasBody = init?.body !== undefined;
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, ...(hasBody ? { "content-type": "application/json" } : {}) },
    body: hasBody ? JSON.stringify(init!.body) : undefined, signal: AbortSignal.timeout(60_000),
  }).catch((e) => { throw new GoogleApiError(0, `Could not reach Google: ${(e as Error).message}`); });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GoogleApiError(res.status, `Google API error (${res.status})`, body.slice(0, 2000), Number(res.headers.get("retry-after")) || null);
  }
  return (await res.json()) as T;
}

export function grantsFor(ctx: Ctx, provider: GoogleProvider) {
  return ctx.db.prepare("SELECT id, account_id, email FROM google_grants WHERE provider=? ORDER BY created_at").all(provider) as { id: string; account_id: string; email: string | null }[];
}

/** The user declined or Google reported an error: drop the state and say which project to return to. */
export function abandonAuthorization(ctx: Ctx, provider: GoogleProvider, state: string | null): string | null {
  if (!state) return null;
  const r = ctx.db.prepare("DELETE FROM google_oauth_states WHERE state=? AND provider=? RETURNING project_id").get(state, provider) as { project_id: string } | undefined;
  return r?.project_id ?? null;
}
