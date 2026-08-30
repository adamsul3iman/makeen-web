/**
 * Hardware & Peripherals Hub — shared type contracts.
 *
 * The hub treats every peripheral as an "intent-target". A UI action raises a
 * typed `PrintIntent` (receipt, label, A4 report, ...); the dispatcher resolves
 * it against a `HardwareHubConfig` (which printer slot is active, which intents
 * kick the cash drawer) and routes the payload to the correct backend. Future
 * peripherals (customer display, scale, scanner) plug in by adding a new slot
 * type here without touching the routing core.
 */

import type { PrinterKind } from "@/lib/printAgent";
import type { PaymentMethod } from "@/types/pos.types";
import type { ShiftAudit } from "@/types/shifts.types";

/** Physical/output classes a printer slot can be assigned to. */
export type SlotKind = PrinterKind;

/** Canonical printer slot ids (also the `Record` keys of the hub config). */
export type SlotId = "RECEIPT" | "LABEL" | "A4";

/**
 * Canonical printer slots. Every slot is a typed channel:
 *   RECEIPT — thermal receipt (80/58mm) for the checkout lane.
 *   LABEL   — barcode/label printer for sticker jobs.
 *   A4      — document/report printer for A4 invoices & shift reports.
 *
 * `deviceName` is the OS printer name (from Electron getPrinters). Empty means
 * the backend auto-resolves by printerKind hints.
 */
export interface PrinterSlot {
  id: SlotId;
  kind: SlotKind;
  label: string;
  /** Arabic heading shown in the Hardware Hub UI. */
  nameAr: string;
  deviceName: string;
  /** Receipt-only: paper width (58 or 80mm). */
  paperWidth?: 58 | 80;
  /** Whether this slot is enabled for dispatch. */
  enabled: boolean;
}

/** Which printer a given print intent should be routed through. */
export interface IntentSlotResolver {
  /** Printer slot id (RECEIPT | LABEL | A4). */
  slotId: SlotId;
  /** Force a fallback kind for browser rendering when unset. */
  fallbackKind: SlotKind;
}

/** Explicit actions that pulse the cash drawer. */
export interface DrawerTriggers {
  /** Open the drawer when a CASH-only sale completes (in addition to SPLIT). */
  cashSale: boolean;
  /** Open the drawer when a SPLIT (cash+card) sale completes. */
  splitSale: boolean;
  /** Whether the manual "فتح الدرج" action is enabled. */
  manual: boolean;
}

/** Physical drawer wiring (ESC/POS pulse). */
export interface DrawerConfig {
  baudRate: 9600 | 19200 | 38400 | 115200;
  /** ESC/POS connector pin (2 = connector 0, 5 = connector 1). */
  pin: 2 | 5;
  triggers: DrawerTriggers;
}

/**
 * The persisted hardware hub configuration, scoped per terminal (like the
 * legacy DeviceHardwareSettings it supersedes).
 */
export interface HardwareHubConfig {
  version: 2;
  slots: Record<SlotId, PrinterSlot>;
  drawer: DrawerConfig;
  /** Manual printer slot resolution overrides by intent. */
  intents: Partial<Record<PrintIntent, IntentSlotResolver>>;
}

/** A resolved, ready-to-fire print request produced by the dispatcher. */
export interface ResolvedPrintRequest {
  intent: PrintIntent;
  slot: PrinterSlot;
  html: string;
  printerName: string | undefined;
  printerKind: SlotKind;
  /** True when the intent's routing says the drawer must kick. */
  kickDrawer: boolean;
}

/** The discrete print actions the POS raises. */
export type PrintIntent =
  | "RECEIPT_CASH" // تأكيد الدفع (نقداً) — receipt + drawer kick
  | "RECEIPT_SPLIT" // الدفع النقد + بطاقة — receipt + optional drawer
  | "RECEIPT_OTHER" // بطاقة / كليك / ذمم — receipt, no drawer
  | "RECEIPT_REPRINT" // إعادة طباعة آخر إيصال
  | "LABEL" // طباعة ملصق باركود
  | "A4_REPORT" // تقارير وردية / فاتورة A4
  | "TEST_RECEIPT" // اختبار الطابعة الحرارية
  | "TEST_LABEL" // اختبار طابعة الملصقات
  | "TEST_A4"; // اختبار طابعة A4

/** Payload union accepted by the dispatcher. */
export interface PrintJobPayload {
  html?: string;
  invoice?: unknown;
  /** Full shift audit for X/Z report intents (rendered server-side by the agent). */
  shift?: ShiftAudit;
  jobType?: string;
  terminalId?: string;
}

/** Guess whether a payment method should kick the drawer (config-aware). */
export function paymentMethodKicksDrawer(
  method: PaymentMethod,
  triggers: DrawerTriggers,
): boolean {
  if (method === "CASH") return triggers.cashSale;
  if (method === "SPLIT") return triggers.splitSale;
  return false;
}
