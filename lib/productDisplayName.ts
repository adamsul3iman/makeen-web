/**
 * Canonical product display name for every customer/staff-facing surface
 * (POS cart, receipts, checkout, sales views): "[Base Name] - [Variant Name]".
 *
 * Inventory / stocktake screens deliberately render the raw base name next to a
 * dedicated barcode chip instead — the manager scans the barcode, not the label.
 */
export function formatProductDisplayName(
  name: string | null | undefined,
  variantLabel?: string | null,
): string {
  const base = typeof name === "string" ? name.trim() : "";
  const variant = typeof variantLabel === "string" ? variantLabel.trim() : "";
  if (!base) return variant;
  if (!variant || variant === base) return base;
  return `${base} - ${variant}`;
}
