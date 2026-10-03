import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";

/**
 * Deterministic stand-in for the Google endpoints CloseSEO uses. Every API host is mounted under "/<host>/..." so one
 * origin serves all of them (GOOGLE_API_ORIGIN). OAuth verifies PKCE (S256), the client secret and the redirect URI.
 * Control: POST /__control {revokeRefresh|accessTtl|ga4Mode|gscMode|sites|properties|email|inspectFail}; GET /__stats.
 */
export type FakeGoogle = {
  origin: string; close(): Promise<void>; control(b: Record<string, unknown>): Promise<void>;
  stats(): { calls: Record<string, number>; bodies: Record<string, any[]>; tokenGrants: string[] };
  /** Simulate Google's consent screen: returns the redirect Location the browser would be sent to. */
  consent(authUrl: string, opts?: { email?: string; sub?: string; deny?: boolean; scopes?: string[]; refresh?: boolean }): { location: string };
  reset(): void;
};

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

export async function startFakeGoogle(opts: { clientId: string; clientSecret: string }): Promise<FakeGoogle> {
  const codes = new Map<string, { challenge: string; redirect: string; scopes: string[]; sub: string; email: string; refresh: boolean }>();
  const access = new Map<string, { sub: string; expires: number }>();
  const refresh = new Map<string, { sub: string }>();
  const accounts = new Map<string, string>();
  let calls: Record<string, number> = {}, bodies: Record<string, any[]> = {}, tokenGrants: string[] = [];
  let ctl: Record<string, any> = {};
  let n = 0;
  const defaults = () => ({ accessTtl: 3600, ga4Mode: "ok", gscMode: "ok", revokeRefresh: false, inspectFail: false,
    sites: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }, { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" }, { siteUrl: "https://unverified.example.org/", permissionLevel: "siteUnverifiedUser" }],
    properties: [{ account: "Acme", props: [{ property: "properties/111", displayName: "Acme Web" }, { property: "properties/222", displayName: "Acme App" }] }] });
  ctl = defaults();

  const doConsent: FakeGoogle["consent"] = (authUrl, o = {}) => {
    const u = new URL(authUrl);
    const redirect = u.searchParams.get("redirect_uri")!, state = u.searchParams.get("state")!;
    if (o.deny) return { location: `${redirect}?error=access_denied&state=${state}` };
    if (u.searchParams.get("client_id") !== opts.clientId) throw new Error("fake consent: wrong client_id");
    if (u.searchParams.get("code_challenge_method") !== "S256") throw new Error("fake consent: PKCE S256 required");
    const code = `code-${++n}`;
    const sub = o.sub ?? "sub-1";
    codes.set(code, { challenge: u.searchParams.get("code_challenge")!, redirect, scopes: o.scopes ?? u.searchParams.get("scope")!.split(" "), sub, email: o.email ?? "owner@example.com", refresh: o.refresh ?? true });
    return { location: `${redirect}?code=${code}&state=${state}` };
  };

  let origin = "";
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (path === "/auth") {
      // The consent screen: approve immediately (add ?deny=1 via the DENY control to simulate refusal).
      const { location } = doConsent(`${origin}${req.url}`, { deny: ctl.deny === true });
      res.writeHead(302, { location }); return void res.end();
    }
    if (path === "/__control") { ctl = { ...ctl, ...JSON.parse(raw || "{}") }; return json(200, {}); }
    calls[path] = (calls[path] ?? 0) + 1;

    if (path === "/token") {
      const f = new URLSearchParams(raw);
      tokenGrants.push(f.get("grant_type") ?? "");
      if (f.get("client_id") !== opts.clientId || f.get("client_secret") !== opts.clientSecret) return json(401, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code") ?? "");
        codes.delete(f.get("code") ?? "");
        if (!c) return json(400, { error: "invalid_grant", error_description: "Bad Request" });
        if (c.redirect !== f.get("redirect_uri")) return json(400, { error: "redirect_uri_mismatch" });
        if (s256(f.get("code_verifier") ?? "") !== c.challenge) return json(400, { error: "invalid_grant", error_description: "Invalid code verifier." });
        const at = `at-${++n}`; access.set(at, { sub: c.sub, expires: Date.now() + ctl.accessTtl * 1000 }); accounts.set(c.sub, c.email);
        const body: Record<string, unknown> = { access_token: at, expires_in: ctl.accessTtl, scope: c.scopes.join(" "), token_type: "Bearer" };
        if (c.refresh) { const rt = `rt-${c.sub}`; refresh.set(rt, { sub: c.sub }); body.refresh_token = rt; }
        return json(200, body);
      }
      if (f.get("grant_type") === "refresh_token") {
        const r = refresh.get(f.get("refresh_token") ?? "");
        if (!r || ctl.revokeRefresh) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        const at = `at-${++n}`; access.set(at, { sub: r.sub, expires: Date.now() + ctl.accessTtl * 1000 });
        return json(200, { access_token: at, expires_in: ctl.accessTtl, token_type: "Bearer" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    const m = path.match(/^\/([^/]+)(\/.*)$/);
    const host = m?.[1], rest = m?.[2] ?? "";
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const tok = access.get(bearer);
    if (!tok || tok.expires < Date.now()) return json(401, { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } });
    let body: any = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
    if (req.method === "POST") (bodies[rest] ??= []).push(body);

    if (host === "openidconnect.googleapis.com") return json(200, { sub: tok.sub, email: accounts.get(tok.sub) });

    if (host === "www.googleapis.com" && rest === "/webmasters/v3/sites") {
      if (ctl.gscMode === "forbidden") return json(403, { error: { message: "forbidden" } });
      return json(200, { siteEntry: ctl.sites });
    }
    if (host === "www.googleapis.com" && rest.endsWith("/searchAnalytics/query")) {
      if (ctl.gscMode === "forbidden") return json(403, { error: { message: "User does not have sufficient permission for site" } });
      if (ctl.gscMode === "rate") return json(429, { error: { message: "Quota exceeded" } });
      if (ctl.gscMode === "boom") return json(500, { error: { message: "backend error" } });
      const dims: string[] = body.dimensions ?? ["query"];
      const total = ctl.gscRows ?? 40, start = body.startRow ?? 0, limit = body.rowLimit ?? 1000;
      const rows = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => {
        const k = start + i;
        const key = (d: string) => (d === "page" ? `https://example.com/page-${k % 30}/` : d === "query" ? `query ${k}` : d === "date" ? `2026-09-${String((k % 28) + 1).padStart(2, "0")}` : d === "country" ? ["usa", "gbr", "deu"][k % 3] : d === "device" ? ["MOBILE", "DESKTOP"][k % 2] : "AMP");
        return { keys: dims.map(key), clicks: 100 - k, impressions: 1000 + (40 - k) * 10, ctr: (100 - k) / (1000 + (40 - k) * 10), position: 1 + (k % 25) + 0.123456 };
      });
      return json(200, rows.length ? { rows } : {});
    }
    if (host === "searchconsole.googleapis.com" && rest === "/v1/urlInspection/index:inspect") {
      if (body.inspectionUrl?.includes("bad") || ctl.inspectFail) return json(400, { error: { message: "URL is not part of the property" } });
      return json(200, { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed", googleCanonical: body.inspectionUrl, lastCrawlTime: "2026-09-20T10:00:00Z", robotsTxtState: "ALLOWED", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL", crawledAs: "MOBILE" }, mobileUsabilityResult: { verdict: "PASS" }, richResultsResult: { verdict: "NEUTRAL" }, inspectionResultLink: "https://search.google.com/search-console/inspect" } });
    }

    if (host === "analyticsadmin.googleapis.com") {
      if (ctl.ga4Mode === "admin403") return json(403, { error: { message: "no" } });
      if (rest === "/v1beta/accountSummaries") return json(200, { accountSummaries: ctl.properties.map((a: any) => ({ name: `accountSummaries/${a.account}`, displayName: a.account, propertySummaries: a.props })) });
      const pm = rest.match(/^\/v1beta\/(properties\/\d+)$/);
      if (pm) { const all = ctl.properties.flatMap((a: any) => a.props); const p = all.find((x: any) => x.property === pm[1]); return p ? json(200, { name: p.property, displayName: p.displayName, timeZone: ctl.tz ?? "America/New_York", currencyCode: "USD" }) : json(404, { error: { message: "not found" } }); }
      if (/\/dataStreams$/.test(rest)) return json(200, { dataStreams: [{ name: "properties/111/dataStreams/9001", type: "WEB_DATA_STREAM", displayName: "Web", createTime: "2025-01-01T00:00:00Z", webStreamData: { measurementId: "G-ABC123", defaultUri: "https://example.com" } }, { name: "properties/111/dataStreams/9002", type: "ANDROID_APP_DATA_STREAM", displayName: "Android" }] });
      if (/enhancedMeasurementSettings$/.test(rest)) return json(200, { streamEnabled: ctl.em !== false, siteSearchEnabled: ctl.siteSearch ?? false });
      if (/\/keyEvents$/.test(rest)) return json(200, ctl.noKeyEvents ? {} : { keyEvents: [{ name: "properties/111/keyEvents/1", eventName: "purchase", custom: false }] });
      if (/\/customDimensions$/.test(rest)) return json(200, { customDimensions: [{ name: "x", parameterName: "plan", displayName: "Plan", scope: "USER" }] });
      if (/\/customMetrics$/.test(rest)) return json(200, {});
    }

    if (host === "analyticsdata.googleapis.com" && rest.endsWith(":runReport")) {
      if (ctl.ga4Mode === "quota") return json(429, { error: { message: "quota" } }, { "retry-after": "120" });
      if (ctl.ga4Mode === "disabled") return json(403, { error: { message: "disabled", details: [{ reason: "SERVICE_DISABLED" }], status: "PERMISSION_DENIED" } });
      if (ctl.ga4Mode === "gone") return json(404, { error: { message: "gone" } });
      if (ctl.ga4Mode === "bad") return json(400, { error: { message: "incompatible" } });
      if (ctl.ga4Mode === "boom") return json(500, { error: { message: "oops" } });
      const dims: string[] = (body.dimensions ?? []).map((d: any) => d.name), mets: string[] = (body.metrics ?? []).map((x: any) => x.name);
      if (ctl.ga4Mode === "headerless") return json(200, {});
      const total = ctl.ga4Rows ?? 12;
      const prevPeriod = (body.dateRanges?.[0]?.endDate ?? "9999") < new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
      const off = Number(body.offset ?? 0), lim = Number(body.limit ?? 10000);
      const val = (d: string, i: number) => d === "hostName" ? "example.com" : d === "landingPage" ? (i === 0 ? "/" : `/page-${i % 30}/`) : d === "pagePath" ? `/page-${i}` : d === "eventName" ? ["purchase", "sign_up", "generate_lead", "scroll", "click"][i % 5]! : d === "sessionDefaultChannelGroup" ? ["Organic Search", "Direct", "Paid Search", "Referral", "Email"][i % 5]! : d === "sessionSourceMedium" ? (i === 0 ? "(not set)" : i === 1 ? "localhost:3000 / referral" : i === 2 ? "Google / organic" : i === 3 ? "google / organic" : `src${i} / medium`) : d === "deviceCategory" ? ["desktop", "mobile", "tablet"][i % 3]! : d === "newVsReturning" ? ["new", "returning"][i % 2]! : d === "date" ? `2026-09-${String((i % 28) + 1).padStart(2, "0")}` : d === "yearWeek" ? `2026${String(30 + (i % 20))}` : d === "searchTerm" ? `term ${i}` : d === "itemName" ? `Item ${i}` : d === "itemId" ? `SKU${i}` : d === "country" ? ["United States", "Germany"][i % 2]! : `${d}-${i}`;
      const mval = (m: string, i: number) => String(m.endsWith("Rate") ? 0.5 - i * 0.01 : m === "purchaseRevenue" || m === "itemRevenue" ? 1000 - i * 10 : (50 - i) * (prevPeriod ? 0.8 : 1));
      const slice = Math.max(0, Math.min(lim, total - off));
      const rows = ctl.ga4Mode === "empty" ? [] : Array.from({ length: slice }, (_, k) => { const i = off + k; return { dimensionValues: dims.map((d) => ({ value: val(d, i) })), metricValues: mets.map((m) => ({ value: ctl.ga4Mode === "nan" && k === 0 ? "oops" : mval(m, i) })) }; });
      const meta: Record<string, unknown> = {};
      if (ctl.ga4Mode === "limited") { meta.subjectToThresholding = true; meta.samplingMetadatas = [{ samplesReadCount: "1000", samplingSpaceSize: "5000" }]; }
      if (ctl.ga4Mode === "restricted") meta.schemaRestrictionResponse = { activeMetricRestrictions: [{ metricName: "purchaseRevenue", restrictedMetricTypes: ["REVENUE_DATA"] }] };
      if (ctl.ga4Mode === "mismatch") return json(200, { dimensionHeaders: [{ name: "wrong" }], metricHeaders: mets.map((name) => ({ name })), rows: [], rowCount: 0 });
      return json(200, { dimensionHeaders: dims.map((name) => ({ name })), metricHeaders: mets.map((name) => ({ name, type: "TYPE_INTEGER" })), rows, rowCount: ctl.ga4Mode === "empty" ? 0 : total, metadata: meta, propertyQuota: { tokensPerDay: { consumed: 5, remaining: 24995 } } });
    }
    return json(404, { error: { message: `no route ${path}` } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
    control: async (b) => { await fetch(`${origin}/__control`, { method: "POST", body: JSON.stringify(b) }); },
    stats: () => ({ calls: { ...calls }, bodies, tokenGrants: [...tokenGrants] }),
    reset() { calls = {}; bodies = {}; tokenGrants = []; ctl = defaults(); },
    consent: (authUrl, o = {}) => doConsent(authUrl, o),
  };
}
