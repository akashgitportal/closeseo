import type { ErrorObject } from "ajv";

type Verbose = ErrorObject & { parentSchema?: Record<string, any>; data?: unknown; schema?: unknown };

const received = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const pathOf = (e: ErrorObject, extra?: string) =>
  [...e.instancePath.split("/").slice(1), ...(extra ? [extra] : [])].filter((p) => p !== "").join(".");

/** Plain-language text for one failed JSON-Schema keyword. */
function describe(e: Verbose): { path: string; message: string } {
  const p = e.params as Record<string, any>;
  const noun = (t: string) => (t === "integer" ? "a whole number" : t === "number" ? "a number" : t === "string" ? "text" : t === "boolean" ? "true or false" : t === "array" ? "a list" : t === "object" ? "an object" : `of type ${t}`);
  switch (e.keyword) {
    case "required": {
      const t = e.parentSchema?.properties?.[p.missingProperty]?.type ?? "value";
      return { path: pathOf(e, p.missingProperty), message: `is required (${noun(Array.isArray(t) ? t[0] : t)})` };
    }
    case "type": {
      const t = Array.isArray(p.type) ? p.type[0] : p.type;
      if (t === "integer" && typeof e.data === "number") return { path: pathOf(e), message: "must be a whole number" };
      return { path: pathOf(e), message: `must be ${noun(t)}, but ${received(e.data)} was given` };
    }
    case "additionalProperties":
      return { path: pathOf(e), message: `contains an unknown field "${p.additionalProperty}"` };
    case "multipleOf":
      return { path: pathOf(e), message: `must be a multiple of ${p.multipleOf}` };
    case "minLength":
      return { path: pathOf(e), message: `needs at least ${p.limit} character${p.limit === 1 ? "" : "s"}` };
    case "maxLength":
      return { path: pathOf(e), message: `allows at most ${p.limit} characters` };
    case "minItems":
      return { path: pathOf(e), message: `needs at least ${p.limit} item${p.limit === 1 ? "" : "s"}` };
    case "maxItems":
      return { path: pathOf(e), message: `allows at most ${p.limit} items` };
    case "minimum":
      return { path: pathOf(e), message: `must be ${p.limit} or more` };
    case "exclusiveMinimum":
      return { path: pathOf(e), message: `must be greater than ${p.limit}` };
    case "maximum":
      return { path: pathOf(e), message: `must be ${p.limit} or less` };
    case "exclusiveMaximum":
      return { path: pathOf(e), message: `must be less than ${p.limit}` };
    case "enum":
      return { path: pathOf(e), message: `must be one of ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}` };
    case "format":
      return { path: pathOf(e), message: p.format === "uuid" ? "is not a valid id" : p.format === "uri" ? "is not a valid URL" : `is not a valid ${p.format}` };
    case "pattern":
      if (e.parentSchema?.format === "uuid") return { path: pathOf(e), message: "is not a valid id" };
      return { path: pathOf(e), message: `does not match the required pattern ${p.pattern}` };
    default:
      return { path: pathOf(e), message: "has an unsupported shape" };
  }
}

const report = (tool: string, issues: string[]) => `Invalid input for ${tool}:\n${issues.map((i) => `- ${i}`).join("\n")}`;

/** Collapse Ajv's error list (one entry per failing keyword, including inside anyOf branches) into one issue per input location. */
export function formatValidationError(tool: string, errors: ErrorObject[]): string {
  // Slug fields get a specific hint rather than the generic union failure.
  const slug = errors.find((e) => e.keyword === "pattern" && /\/(customSection|deleteCustomSection)$/.test(e.instancePath));
  if (slug) return report(tool, [`${pathOf(slug)} must be a lowercase slug such as "launch-plan"`]);
  const seen = new Set<string>();
  const issues: string[] = [];
  const unions = errors.filter((e) => e.keyword === "anyOf" || e.keyword === "oneOf").map((e) => e.instancePath);
  // A union with exactly one plausible branch (all its required keys present) whose only problem is a size bound
  // reports that bound at its real path instead of the generic union failure.
  const deep = new Set<ErrorObject>();
  for (const u of errors.filter((x) => x.keyword === "anyOf" || x.keyword === "oneOf")) {
    const inside = errors.filter((e) => e !== u && e.instancePath.startsWith(u.instancePath) && e.schemaPath.startsWith(u.schemaPath.replace(/\/(anyOf|oneOf)$/, "")) && /\/(anyOf|oneOf)\/\d+/.test(e.schemaPath));
    const byBranch = new Map<string, ErrorObject[]>();
    for (const e of inside) { const k = (e.schemaPath.match(/\/(?:anyOf|oneOf)\/(\d+)/) ?? [])[1] ?? "?"; byBranch.set(k, [...(byBranch.get(k) ?? []), e]); }
    const plausible = [...byBranch.values()].filter((es) => !es.some((e) => e.keyword === "required" || e.keyword === "additionalProperties" || e.keyword === "type"));
    if (plausible.length === 1 && plausible[0]!.every((e) => /^(minItems|maxItems|minLength|maxLength|minimum|maximum)$/.test(e.keyword))) plausible[0]!.forEach((e) => deep.add(e));
  }
  for (const e of errors as Verbose[]) {
    if (deep.has(e)) { const d = describe(e); const k = `${d.path}|${d.message}`; if (!seen.has(k)) { seen.add(k); issues.push(`${d.path} ${d.message}`); } continue; }
    // Errors raised inside a union branch are subsumed by the union's own "Invalid input".
    const insideUnion = e.keyword !== "anyOf" && e.keyword !== "oneOf" && /\/(anyOf|oneOf)\/\d+/.test(e.schemaPath) && unions.some((u) => e.instancePath.startsWith(u));
    if (insideUnion) continue;
    if (e.keyword === "anyOf" && [...deep].some((x) => x.instancePath.startsWith(e.instancePath))) continue;
    const d = describe(e);
    const key = `${d.path}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(d.path ? `${d.path} ${d.message}` : `input ${d.message}`);
  }
  return report(tool, issues);
}

const DOMAIN_TARGET = /^(?!https?:\/\/)(?!www\.)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const LANGUAGE_MESSAGE = "is not a supported language code; use a code such as \"en\", \"es\", \"de\" or \"fr\"";

/** Walk the input and report any `languageCode` that is not a supported language (one issue per location). */
function languageIssues(value: unknown, path: string[], out: string[], isLang: (c: string) => boolean) {
  if (Array.isArray(value)) value.forEach((v, i) => languageIssues(v, [...path, String(i)], out, isLang));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k === "languageCode" && typeof v === "string" && !isLang(v)) out.push(`${[...path, k].join(".")} ${LANGUAGE_MESSAGE}`);
      else languageIssues(v, [...path, k], out, isLang);
    }
}

/** Rules that the JSON Schema cannot express (value sets, refinements, language lists). */
export function extraRuleError(tool: string, input: Record<string, unknown>, isLang: (code: string) => boolean): string | null {
  const issues: string[] = [];
  if (tool === "get_backlinks_profile" && input.pageSize !== undefined && ![50, 100, 200].includes(input.pageSize as number)) issues.push("pageSize must be 50, 100 or 200");
  if (tool === "get_ranked_keywords" && typeof input.target === "string" && !(/^https?:\/\/\S+$/.test(input.target) || DOMAIN_TARGET.test(input.target)))
    issues.push("target must be a bare domain (no protocol, no www) or a full page URL");
  // inspect_urls takes a BCP-47 tag ("en-US"); every other languageCode is a DataForSEO language code.
  if (tool !== "inspect_urls") languageIssues(input, [], issues, isLang);
  return issues.length ? report(tool, issues) : null;
}
