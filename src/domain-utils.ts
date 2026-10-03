import { AppError } from "./errors.ts";

/** Reduce user input ("https://www.Example.com/path") to a bare lowercase host. */
export const DOMAIN_MESSAGE = "Enter a valid domain like example.com";

export function normalizeDomain(input: string, message = DOMAIN_MESSAGE): string {
  let s = input.trim().toLowerCase();
  if (!s) throw new AppError("VALIDATION_ERROR", message);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0]!.replace(/:\d+$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    throw new AppError("VALIDATION_ERROR", message);
  }
  return s;
}

export function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** True when `host` is `domain` or a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
