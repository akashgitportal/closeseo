import type { ErrorObject } from "ajv";

type Verbose = ErrorObject & { parentSchema?: Record<string, any>; data?: unknown; schema?: unknown };

const received = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const pathOf = (e: ErrorObject, extra?: string) =>
  [...e.instancePath.split("/").slice(1), ...(extra ? [extra] : [])].filter((p) => p !== "").join(".");

/** Human-readable text for one failed JSON-Schema keyword, phrased like the SOURCE server's validator. */
function describe(e: Verbose): { path: string; message: string } {
  const p = e.params as Record<string, any>;
  switch (e.keyword) {
    case "required": {
      const t = e.parentSchema?.properties?.[p.missingProperty]?.type ?? "value";
      const expected = Array.isArray(t) ? t[0] : t;
      return { path: pathOf(e, p.missingProperty), message: `Invalid input: expected ${expected === "integer" ? "number" : expected}, received undefined` };
    }
    case "type": {
      const t = Array.isArray(p.type) ? p.type[0] : p.type;
      // A number that is merely not whole is an "int" failure; anything else is a plain type mismatch.
      if (t === "integer") return { path: pathOf(e), message: typeof e.data === "number" ? "Invalid input: expected int, received number" : `Invalid input: expected number, received ${received(e.data)}` };
      return { path: pathOf(e), message: `Invalid input: expected ${t}, received ${received(e.data)}` };
    }
    case "additionalProperties":
      return { path: pathOf(e), message: `Unrecognized key: "${p.additionalProperty}"` };
    case "multipleOf":
      return { path: pathOf(e), message: `Invalid number: must be a multiple of ${p.multipleOf}` };
    case "minLength":
      return { path: pathOf(e), message: `Too small: expected string to have >=${p.limit} characters` };
    case "maxLength":
      return { path: pathOf(e), message: `Too big: expected string to have <=${p.limit} characters` };
    case "minItems":
      return { path: pathOf(e), message: `Too small: expected array to have >=${p.limit} items` };
    case "maxItems":
      return { path: pathOf(e), message: `Too big: expected array to have <=${p.limit} items` };
    case "minimum":
      return { path: pathOf(e), message: `Too small: expected number to be >=${p.limit}` };
    case "exclusiveMinimum":
      return { path: pathOf(e), message: `Too small: expected number to be >${p.limit}` };
    case "maximum":
      return { path: pathOf(e), message: `Too big: expected number to be <=${p.limit}` };
    case "exclusiveMaximum":
      return { path: pathOf(e), message: `Too big: expected number to be <${p.limit}` };
    case "enum":
      return { path: pathOf(e), message: `Invalid option: expected one of ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join("|")}` };
    case "format":
      return { path: pathOf(e), message: p.format === "uuid" ? "Invalid UUID" : p.format === "uri" ? "Invalid URL" : `Invalid ${p.format}` };
    case "pattern":
      if (e.parentSchema?.format === "uuid") return { path: pathOf(e), message: "Invalid UUID" };
      return { path: pathOf(e), message: `Invalid string: must match pattern /${p.pattern}/` };
    default:
      return { path: pathOf(e), message: "Invalid input" };
  }
}

/** Collapse Ajv's error list (one entry per failing keyword, including inside anyOf branches) into one issue per input location. */
export function formatValidationError(tool: string, errors: ErrorObject[]): string {
  // The SOURCE gives slug fields a bespoke message rather than the generic union failure.
  const slug = errors.find((e) => e.keyword === "pattern" && /\/(customSection|deleteCustomSection)$/.test(e.instancePath));
  if (slug) return `Input validation error: Invalid arguments for tool ${tool}: ${pathOf(slug)}: Use a lowercase slug like 'launch-plan'`;
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
    if (deep.has(e)) { const d = describe(e); const k = `${d.path}|${d.message}`; if (!seen.has(k)) { seen.add(k); issues.push(`${d.path}: ${d.message}`); } continue; }
    // Errors raised inside a union branch are subsumed by the union's own "Invalid input".
    const insideUnion = e.keyword !== "anyOf" && e.keyword !== "oneOf" && /\/(anyOf|oneOf)\/\d+/.test(e.schemaPath) && unions.some((u) => e.instancePath.startsWith(u));
    if (insideUnion) continue;
    if (e.keyword === "anyOf" && [...deep].some((x) => x.instancePath.startsWith(e.instancePath))) continue;
    const d = describe(e);
    const key = `${d.path}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(d.path ? `${d.path}: ${d.message}` : d.message);
  }
  return `Input validation error: Invalid arguments for tool ${tool}: ${issues.join(", ")}`;
}

const DOMAIN_TARGET = /^(?!https?:\/\/)(?!www\.)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const LANGUAGE_MESSAGE = "Unsupported language code. Use a supported code such as 'en', 'es', 'de', or 'fr'.";

/** Walk the input and report any `languageCode` that is not a supported language (one issue per location). */
function languageIssues(value: unknown, path: string[], out: string[], isLang: (c: string) => boolean) {
  if (Array.isArray(value)) value.forEach((v, i) => languageIssues(v, [...path, String(i)], out, isLang));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k === "languageCode" && typeof v === "string" && !isLang(v)) out.push(`${[...path, k].join(".")}: ${LANGUAGE_MESSAGE}`);
      else languageIssues(v, [...path, k], out, isLang);
    }
}

/** Rules the SOURCE enforces beyond what its JSON Schema expresses (value sets, refinements, language lists). */
export function extraRuleError(tool: string, input: Record<string, unknown>, isLang: (code: string) => boolean): string | null {
  const issues: string[] = [];
  if (tool === "get_backlinks_profile" && input.pageSize !== undefined && ![50, 100, 200].includes(input.pageSize as number)) issues.push("pageSize: Invalid input");
  if (tool === "get_ranked_keywords" && typeof input.target === "string" && !(/^https?:\/\/\S+$/.test(input.target) || DOMAIN_TARGET.test(input.target)))
    issues.push("target: Use a domain without protocol/www or an absolute page URL.");
  // inspect_urls takes a BCP-47 tag ("en-US"); every other languageCode is a DataForSEO language code.
  if (tool !== "inspect_urls") languageIssues(input, [], issues, isLang);
  return issues.length ? `Input validation error: Invalid arguments for tool ${tool}: ${issues.join(", ")}` : null;
}
