import type { Ctx } from "../ctx.ts";
import { newId, nowIso } from "../db.ts";
import { normalizeDomain } from "../domain-utils.ts";
import { AppError } from "../errors.ts";
import { DEFAULT_LOCATION, getLanguageCode } from "./markets.ts";

export type Project = {
  id: string;
  name: string;
  domain: string | null;
  locationCode: number;
  languageCode: string;
};

type Row = {
  id: string;
  name: string;
  domain: string | null;
  location_code: number;
  language_code: string;
};
const toProject = (r: Row): Project => ({
  id: r.id,
  name: r.name,
  domain: r.domain,
  locationCode: r.location_code,
  languageCode: r.language_code,
});

export function createProject(
  ctx: Ctx,
  input: {
    name: string;
    domain?: string | null;
    locationCode?: number;
    languageCode?: string;
  },
): Project {
  const name = input.name.trim();
  if (!name || name.length > 120)
    throw new AppError("VALIDATION_ERROR", "A project name needs 1 to 120 characters");
  if (input.languageCode && input.locationCode === undefined)
    throw new AppError("VALIDATION_ERROR", "languageCode can only be set together with locationCode");
  const locationCode = input.locationCode ?? DEFAULT_LOCATION;
  const languageCode = input.languageCode ?? getLanguageCode(locationCode);
  const domain = input.domain ? normalizeDomain(input.domain, "That does not look like a domain name (expected something like acme.com)") : null;
  const id = newId();
  ctx.db
    .prepare(
      "INSERT INTO projects (id,name,domain,location_code,language_code,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(id, name, domain, locationCode, languageCode, nowIso());
  return { id, name, domain, locationCode, languageCode };
}

export function listProjects(ctx: Ctx): Project[] {
  return (
    ctx.db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as Row[]
  ).map(toProject);
}

export function getProject(ctx: Ctx, id: string): Project {
  const r = ctx.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new AppError("NOT_FOUND", "No project with that id exists");
  return toProject(r);
}

export function updateProject(
  ctx: Ctx,
  id: string,
  patch: { name?: string; domain?: string | null; locationCode?: number; languageCode?: string },
): Project {
  const cur = getProject(ctx, id);
  const locationCode = patch.locationCode ?? cur.locationCode;
  const languageCode =
    patch.languageCode ??
    (patch.locationCode !== undefined ? getLanguageCode(locationCode) : cur.languageCode);
  const name = patch.name?.trim() ?? cur.name;
  if (!name || name.length > 120)
    throw new AppError("VALIDATION_ERROR", "A project name needs 1 to 120 characters");
  const domain =
    patch.domain === undefined ? cur.domain : patch.domain ? normalizeDomain(patch.domain, "That does not look like a domain name (expected something like acme.com)") : null;
  ctx.db
    .prepare("UPDATE projects SET name=?, domain=?, location_code=?, language_code=? WHERE id=?")
    .run(name, domain, locationCode, languageCode, id);
  return { id, name, domain, locationCode, languageCode };
}

export function deleteProject(ctx: Ctx, id: string): void {
  getProject(ctx, id);
  ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}
