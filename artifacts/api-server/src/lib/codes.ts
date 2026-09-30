import { randomInt } from "node:crypto";
import { sastDateLabel } from "./period";

const ALPHANUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomCode(length: number, alphabet = ALPHANUM) {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** e.g. MSM-000123 */
export const resellerCodeFor = (id: number) => `MSM-${String(id).padStart(6, "0")}`;

/** e.g. NOMDADE123 — first-name letters plus three digits. */
export function referralCodeFor(firstName: string) {
  const letters = firstName.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8) || "MASMILA";
  return `${letters}${randomInt(100, 1000)}`;
}

/** e.g. MM-260929-4821 */
export function orderNumber(now = new Date()) {
  return `MM-${sastDateLabel(now).slice(2).replaceAll("-", "")}-${randomCode(4, "0123456789")}`;
}

export const applicationNumber = () => `APP-${randomCode(8)}`;

export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Postgres unique-violation check for retry loops. */
export function isUniqueViolation(err: unknown) {
  const code = (err as { code?: string; cause?: { code?: string } })?.code ??
    (err as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}
