import type { Money } from "@/types/pos.types";

const CURRENCY = "د.أ";

export function formatMoney(value: Money): string {
  const safe = Number.isFinite(value) ? value : 0;
  const formatted = safe.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${CURRENCY}`;
}
