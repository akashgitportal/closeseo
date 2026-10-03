import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const key = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "closeseo.google-tokens.v1", "aes-256-gcm", 32));

/** AES-256-GCM encryption. The result looks like "v1.<iv>.<tag>.<ciphertext>" in base64url, with a new random IV for each value. */
export function encrypt(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(secret: string, blob: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Stored token is not in a known format");
  const d = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
