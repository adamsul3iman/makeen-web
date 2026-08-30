/**
 * Hardware & Peripherals Hub — canonical slot identifiers and intent defaults.
 */

import type { IntentSlotResolver, PrintIntent, SlotId } from "./types";

/** Printer slot ids (also used as the `Record` keys in the hub config). */
export const SLOT_RECEIPT = "RECEIPT" as const;
export const SLOT_LABEL = "LABEL" as const;
export const SLOT_A4 = "A4" as const;

export const ALL_SLOTS = [SLOT_RECEIPT, SLOT_LABEL, SLOT_A4] as const;

/** Re-exported so callers can import the id type from the natural module. */
export type { SlotId };

/** Default intent → slot routing when no per-intent override is configured. */
export const DEFAULT_INTENT_SLOTS: Record<PrintIntent, IntentSlotResolver> = {
  RECEIPT_CASH: { slotId: SLOT_RECEIPT, fallbackKind: "THERMAL" },
  RECEIPT_SPLIT: { slotId: SLOT_RECEIPT, fallbackKind: "THERMAL" },
  RECEIPT_OTHER: { slotId: SLOT_RECEIPT, fallbackKind: "THERMAL" },
  RECEIPT_REPRINT: { slotId: SLOT_RECEIPT, fallbackKind: "THERMAL" },
  LABEL: { slotId: SLOT_LABEL, fallbackKind: "LABEL" },
  A4_REPORT: { slotId: SLOT_A4, fallbackKind: "A4" },
  TEST_RECEIPT: { slotId: SLOT_RECEIPT, fallbackKind: "THERMAL" },
  TEST_LABEL: { slotId: SLOT_LABEL, fallbackKind: "LABEL" },
  TEST_A4: { slotId: SLOT_A4, fallbackKind: "A4" },
};
