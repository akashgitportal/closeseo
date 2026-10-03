import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { AppError } from "../errors.ts";

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isBlockedAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const s = addr.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff");
  }
  return true;
}

export function assertCrawlableUrl(raw: string, allowPrivate = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR", `"${raw}" is not a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new AppError("VALIDATION_ERROR", "Only http and https URLs can be audited");
  if (u.username || u.password)
    throw new AppError("VALIDATION_ERROR", "URLs with embedded credentials are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
      throw new AppError("VALIDATION_ERROR", "Private and local addresses cannot be audited");
    if (isIP(host) && isBlockedAddress(host))
      throw new AppError("VALIDATION_ERROR", "Private and local addresses cannot be audited");
  }
  return u;
}

/** dns.lookup replacement used at connect time so DNS rebinding cannot reach private ranges. */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: unknown, cb: (...a: unknown[]) => void) => {
    const opts = typeof options === "function" ? {} : (options as object);
    const done = (typeof options === "function" ? options : cb) as (...a: unknown[]) => void;
    dnsLookup(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return done(err);
      const list = addrs as { address: string; family: number }[];
      if (!allowPrivate && list.some((a) => isBlockedAddress(a.address)))
        return done(new Error(`Blocked: ${hostname} resolves to a private address`));
      if ((opts as { all?: boolean }).all) return done(null, list);
      done(null, list[0]!.address, list[0]!.family);
    });
  };
}
