/**
 * UUID v4 generator that prefers the secure `crypto.randomUUID()`
 * (available on localhost/HTTPS) and falls back to a manual RFC-4122
 * generator for non-secure LAN contexts.
 */
export function newUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PoUuidReferenceKind = "variant" | "unit";

/** Normalize legacy PO matrix references before they reach UUID columns. */
export function normalizePoUuidReference(
  value: unknown,
  kind: PoUuidReferenceKind,
): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean) return null;
  if (UUID_RE.test(clean)) return clean;

  const parts = clean.split(":").map((part) => part.trim());
  if (parts.length !== 2) {
    throw new Error(`معرف ${kind === "variant" ? "المتغير" : "الوحدة"} غير صالح`);
  }

  const [first, second] = parts;
  const baseReference = second === "base" || second === "_base";

  if (kind === "variant") {
    // Package barcodes are represented locally as "unitUuid:unit" and have
    // no variant relation. Matrix keys use "variantUuid:unitUuid/base".
    if (second === "unit" && UUID_RE.test(first)) return null;
    if (UUID_RE.test(first) && (baseReference || UUID_RE.test(second))) return first;
  } else {
    if (baseReference && UUID_RE.test(first)) return null;
    if (second === "unit" && UUID_RE.test(first)) return first;
    if (UUID_RE.test(first) && UUID_RE.test(second)) return second;
  }

  throw new Error(`معرف ${kind === "variant" ? "المتغير" : "الوحدة"} غير صالح`);
}
