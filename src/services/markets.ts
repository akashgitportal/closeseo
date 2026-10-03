import { createRequire } from "node:module";
import { AppError } from "../errors.ts";

const require = createRequire(import.meta.url);
type Country = { code: number; name: string; iso: string; language: string; adsOnly?: true };
const data = require("../data/markets.json") as {
  countries: Country[];
  multiLanguage: Record<string, string[]>;
  languages: { code: string; name: string }[];
};

export const DEFAULT_LOCATION = 2840;
export type Market = { locationCode: number; languageCode: string };

const byCode = new Map(data.countries.map((c) => [c.code, c]));
const languageCodes = new Set(data.languages.map((l) => l.code));

export const getLanguageCode = (locationCode: number) => byCode.get(locationCode)?.language ?? "en";
/** @deprecated alias kept for older call sites */
export const languageForLocation = getLanguageCode;
export const isSupportedLanguageCode = (code: string) => languageCodes.has(code);
export const countryName = (locationCode: number) => byCode.get(locationCode)?.name ?? "this country";

/** Lower-case ISO 3166-1 alpha-2 code used by DataForSEO's per-country endpoints. */
export function isoCountryCode(locationCode: number): string {
  const short = byCode.get(locationCode)?.iso ?? "US";
  return (short === "UK" ? "GB" : short).toLowerCase();
}

/** Labs is the default provider; countries it does not cover are served from Google Ads data. Unknown codes fall back to Labs. */
export function getKeywordDataProvider(locationCode: number): "labs" | "google_ads" {
  return byCode.get(locationCode)?.adsOnly ? "google_ads" : "labs";
}

export function getLanguageOptions(locationCode: number): string[] {
  return data.multiLanguage[String(locationCode)] ?? [getLanguageCode(locationCode)];
}

export function isLanguageServedForLocation(locationCode: number, languageCode: string): boolean {
  if (getKeywordDataProvider(locationCode) !== "labs") return true;
  return getLanguageOptions(locationCode).includes(languageCode);
}

/**
 * A request's market against the project's default. Overriding only the location snaps the
 * language to that location's default (the project's language may not be valid for it).
 */
export function resolveMarket(args: { locationCode?: number; languageCode?: string }, project: Market): Market {
  const locationCode = args.locationCode ?? project.locationCode;
  const languageCode = args.languageCode ?? (locationCode === project.locationCode ? project.languageCode : getLanguageCode(locationCode));
  return { locationCode, languageCode };
}

/** Like resolveMarket, but a project default that Labs cannot serve is replaced by the United States. */
export function resolveLabsMarket(args: { locationCode?: number; languageCode?: string }, project: Market): Market {
  const served = getKeywordDataProvider(project.locationCode) === "labs" && isLanguageServedForLocation(project.locationCode, project.languageCode);
  return resolveMarket(args, served ? project : { locationCode: DEFAULT_LOCATION, languageCode: "en" });
}

export function assertLabsLocationCode(locationCode: number | undefined) {
  if (locationCode != null && getKeywordDataProvider(locationCode) !== "labs")
    throw new AppError("VALIDATION_ERROR", "Domain analytics is not available for this country. Keyword research and rank tracking work; domain-level data is limited to DataForSEO Labs locations.");
}

export function assertLanguageForLocation(locationCode: number | undefined, languageCode: string | undefined) {
  if (languageCode == null) return;
  const loc = locationCode ?? DEFAULT_LOCATION;
  if (isLanguageServedForLocation(loc, languageCode)) return;
  throw new AppError("VALIDATION_ERROR", `Language '${languageCode}' is not available for this location. Available: ${getLanguageOptions(loc).join(", ")}.`);
}
