import { parse as parseTld } from "tldts";
import { AppError } from "../errors.ts";

export type ResearchScope = "exact_url" | "subfolder" | "domain" | "subdomains";
export const RESEARCH_SCOPES: readonly ResearchScope[] = ["exact_url", "subfolder", "domain", "subdomains"];

export type ResearchTarget = {
  scope: ResearchScope;
  /** Lower-cased hostname without a leading `www.`. */
  hostname: string;
  /** Hostname as entered (lower-cased, `www.` preserved). */
  urlHostname: string;
  /** "" for the root, otherwise "/like/This" (case kept, trailing slash / query / fragment removed). */
  path: string;
  /** What to show users: the hostname, plus the path for URL-scoped research. */
  display: string;
};

/** True when `host` is a real registrable domain (public-suffix list); rejects IPs and fake TLDs. */
export function isValidDomainHost(host: string): boolean {
  const p = parseTld(host, { allowPrivateDomains: true });
  return !p.isIp && !!p.publicSuffix && (p.isIcann === true || p.isPrivate === true);
}

const VALID_DOMAIN_MESSAGE = "Enter a valid domain like example.com";

export function parseResearchTarget(input: string, requested?: ResearchScope): ResearchTarget {
  const trimmed = input.trim();
  if (!trimmed) throw new AppError("VALIDATION_ERROR", "Enter a domain or URL");
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new AppError("VALIDATION_ERROR", VALID_DOMAIN_MESSAGE);
  }
  if (url.username || url.password) throw new AppError("VALIDATION_ERROR", "URLs with embedded credentials are not supported");
  const urlHostname = url.hostname.toLowerCase();
  const hostname = urlHostname.replace(/^www\./, "");
  // The charset check rejects hosts like my_site.com that URL() accepts but DataForSEO bills and then fails.
  if (!hostname || !hostname.includes(".") || !/^[a-z\d.-]+$/.test(hostname) || !isValidDomainHost(hostname))
    throw new AppError("VALIDATION_ERROR", VALID_DOMAIN_MESSAGE);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  if (requested === "subfolder" && path === "") throw new AppError("VALIDATION_ERROR", "Add a path to use Subfolder (e.g. example.com/blog)");
  const scope = requested ?? (path === "" ? "subdomains" : "subfolder");
  const usesPath = scope === "exact_url" || scope === "subfolder";
  return { scope, hostname, urlHostname, path, display: usesPath ? `${hostname}${path}` : hostname };
}

export const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");

type Clause = unknown[];
/** AND a list of clauses/expressions into one DataForSEO filter expression (nested arrays group). */
export function joinFilters(clauses: (Clause | null | undefined)[], op: "and" | "or" = "and"): Clause | undefined {
  const parts = clauses.filter((c): c is Clause => Array.isArray(c));
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  const out: unknown[] = [];
  parts.forEach((p, i) => { if (i) out.push(op); out.push(p); });
  return out;
}

/**
 * Provider-side scope filter for Labs ranked_keywords. A Labs domain target rolls up the hostname AND its
 * subdomains, so every scope narrower than `subdomains` needs conditions on the result hostname / path.
 */
export function rankedKeywordsScopeFilter(t: ResearchTarget): Clause | undefined {
  if (t.scope === "subdomains") return undefined;
  const hostClause = joinFilters([["ranked_serp_element.serp_item.domain", "=", t.hostname], ["ranked_serp_element.serp_item.domain", "=", `www.${t.hostname}`]], "or");
  if (t.scope === "domain") return hostClause;
  const field = "ranked_serp_element.serp_item.relative_url";
  const p = escapeLike(t.path);
  const pathClause =
    t.scope === "exact_url"
      ? joinFilters([[field, "=", t.path], [field, "like", `${p}?%`]], "or")
      : joinFilters([[field, "=", t.path], [field, "like", `${p}/%`], [field, "like", `${p}?%`]], "or");
  return joinFilters([hostClause, pathClause], "and");
}
