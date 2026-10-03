import { Agent, fetch as undiciFetch } from "undici";
import { assertCrawlableUrl, guardedLookup } from "./url-policy.ts";

export type FetchResult = {
  status: number | null;
  finalUrl: string;
  redirects: number;
  redirectLoop: boolean;
  contentType: string | null;
  body: string | null;
  ms: number;
  error: string | null;
};

export const USER_AGENT = "CloseSEOBot/0.1 (+site-audit)";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export type Fetcher = (url: string, signal?: AbortSignal) => Promise<FetchResult>;

export function createFetcher(opts: { allowPrivate: boolean; timeoutMs?: number }): Fetcher {
  const agent = new Agent({
    connect: { lookup: guardedLookup(opts.allowPrivate) as never },
    headersTimeout: opts.timeoutMs ?? 15_000,
    bodyTimeout: opts.timeoutMs ?? 15_000,
  });
  return async (url, signal) => {
    const started = Date.now();
    let current = url;
    const seen = new Set<string>();
    let redirects = 0;
    try {
      for (;;) {
        assertCrawlableUrl(current, opts.allowPrivate);
        if (seen.has(current)) return { status: null, finalUrl: current, redirects, redirectLoop: true, contentType: null, body: null, ms: Date.now() - started, error: "Redirect loop" };
        seen.add(current);
        const res = await undiciFetch(current, {
          redirect: "manual",
          dispatcher: agent,
          headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 15_000)]) : AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
        const loc = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && loc) {
          await res.body?.cancel();
          if (++redirects > MAX_REDIRECTS) return { status: null, finalUrl: current, redirects, redirectLoop: true, contentType: null, body: null, ms: Date.now() - started, error: "Too many redirects" };
          current = new URL(loc, current).href;
          continue;
        }
        const contentType = res.headers.get("content-type");
        let body: string | null = null;
        if (contentType && /(html|xml|text\/plain)/i.test(contentType)) {
          const chunks: Uint8Array[] = [];
          let size = 0;
          const reader = res.body?.getReader();
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) { await reader.cancel(); break; }
            chunks.push(value);
          }
          body = Buffer.concat(chunks).toString("utf8");
        } else await res.body?.cancel();
        return { status: res.status, finalUrl: current, redirects, redirectLoop: false, contentType, body, ms: Date.now() - started, error: null };
      }
    } catch (e) {
      const err = e as Error & { cause?: Error };
      return { status: null, finalUrl: current, redirects, redirectLoop: false, contentType: null, body: null, ms: Date.now() - started, error: err.cause?.message ?? err.message };
    }
  };
}
