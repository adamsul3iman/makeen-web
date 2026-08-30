/**
 * Hardware & Peripherals Hub — intent dispatcher.
 *
 * `dispatchPrintJob(intent, payload)` is the single choke point that maps a
 * business action to a printer slot and (optionally) a cash-drawer kick. UI
 * components never talk to printers directly; they raise an intent and read a
 * normalized result.
 *
 * Routing contract:
 *   • RECEIPT_* intents  → RECEIPT slot (thermal). No native dialog in Electron
 *                          (uses the silent bridge); browser uses smartPrint's
 *                          hidden-iframe fallback.
 *   • LABEL intents      → LABEL slot.
 *   • A4_REPORT intents  → A4 slot (native dialog allowed in browser).
 *
 * The cash drawer is pulsed when the intent is a cash-bearing sale AND the
 * drawer routing config allows it — resolved inside this module so every
 * trigger point is centralized and auditable.
 */

import {
  isElectron,
  looksLikeHtmlDocument,
  printInBrowser,
  printReceiptSilently,
  smartPrint,
  type PrinterKind,
} from "@/lib/printAgent";
import { openCashDrawer } from "@/lib/cashDrawer";
import { loadHardwareHubConfig } from "./config";
import { DEFAULT_INTENT_SLOTS, SLOT_LABEL } from "./slots";
import type {
  HardwareHubConfig,
  PrintIntent,
  PrintJobPayload,
  PrinterSlot,
} from "./types";
import { paymentMethodKicksDrawer } from "./types";

/**
 * Graphical intents: their output is an HTML document that MUST be rendered by
 * a webContents.print / iframe graphics path — never by a raw label spooler.
 */
const GRAPHICAL_INTENTS = new Set<PrintIntent>([
  "RECEIPT_CASH",
  "RECEIPT_SPLIT",
  "RECEIPT_OTHER",
  "RECEIPT_REPRINT",
  "A4_REPORT",
  "TEST_RECEIPT",
  "TEST_A4",
]);

/**
 * The ONLY intents allowed to touch the LABEL slot. Raw string commands
 * (TSPL/ESC-POS buffers) are reserved for barcode labels and must be generated
 * and emitted exclusively through this channel — never for receipts/reports.
 */
const LABEL_ONLY_INTENTS = new Set<PrintIntent>(["LABEL", "TEST_LABEL"]);

export interface DispatchResult {
  intent: PrintIntent;
  slotId: string;
  /** True when a real spooler/backend accepted the print (if printing happened). */
  printed: boolean;
  /** True if an explicit print was requested. False for e.g. a pure drawer intent. */
  attempted: boolean;
  /** Whether the cash drawer was (or should have been) pulsed. */
  kickedDrawer: boolean;
  drawerOk: boolean;
  error?: string;
  /** Payload may be `undefined` when the caller only wants the drawer decision. */
  skippedPrint?: boolean;
}

interface PaymentAwareContext {
  paymentMethod?: "CASH" | "SPLIT" | "VISA" | "DEBT" | "CLIQ";
  autoOpenDrawer?: boolean;
}

/**
 * Resolve the active slot for an intent. Per-intent overrides from the config
 * win; otherwise the canonical default mapping is used. If the configured slot
 * is missing or disabled we fall back to a safe, always-enabled default slot
 * so a mis-saved config never silently drops a print.
 */
export function resolveSlot(intent: PrintIntent, config: HardwareHubConfig): PrinterSlot {
  let resolver = config.intents[intent] ?? DEFAULT_INTENT_SLOTS[intent];

  // Receipt/report intents are graphical — they print rendered HTML and must
  // NEVER resolve to the LABEL (raw label/TSPL) slot. A mis-saved override
  // that points a receipt at the label device is exactly how a receipt gets
  // printed as raw "SIZE / SET PEEL / PRINT" commands, so it is ignored here
  // with a loud warning instead of being one misconfiguration away from the
  // thermal paper. Only LABEL / TEST_LABEL may use the LABEL slot.
  if (GRAPHICAL_INTENTS.has(intent) && resolver.slotId === SLOT_LABEL) {
    console.warn(
      "[hardware-dispatch] Ignoring LABEL-slot override for graphical intent",
      intent,
      "(receipts/reports must render HTML via the graphics bridge)",
    );
    resolver = DEFAULT_INTENT_SLOTS[intent];
  }
  if (LABEL_ONLY_INTENTS.has(intent) && resolver.slotId !== SLOT_LABEL) {
    console.warn(
      "[hardware-dispatch] Forcing LABEL intent onto the LABEL slot",
      intent,
    );
    resolver = DEFAULT_INTENT_SLOTS[intent];
  }

  const configured = config.slots[resolver.slotId];
  if (configured?.enabled) return configured;

  // Fall back to the canonical default for this intent.
  const canonical = DEFAULT_INTENT_SLOTS[intent];
  const fallback = config.slots[canonical.slotId];
  if (fallback?.enabled) return fallback;

  return {
    id: canonical.slotId,
    kind: canonical.fallbackKind,
    label: canonical.slotId,
    nameAr: canonical.slotId,
    deviceName: "",
    enabled: true,
  };
}

/** Decide whether an intent should trigger a cash-drawer kick. */
export function intentKicksDrawer(
  intent: PrintIntent,
  config: HardwareHubConfig,
  context?: PaymentAwareContext,
): boolean {
  const triggers = config.drawer.triggers;
  if (intent === "RECEIPT_CASH" || intent === "RECEIPT_SPLIT") {
    if (intent === "RECEIPT_CASH" && !triggers.cashSale) return false;
    if (intent === "RECEIPT_SPLIT" && !triggers.splitSale) return false;
    return true;
  }
  if (intent === "RECEIPT_OTHER") return false;
  // Payment-aware callers may already know the method; reuse the mapping so the
  // drawer only opens for cash-bearing flows.
  if (context?.paymentMethod) {
    return paymentMethodKicksDrawer(context.paymentMethod, triggers);
  }
  return false;
}

/**
 * Route a print job by intent. Returns a normalized result; caller decides how
 * to surface success/failure to the operator.
 */
export async function dispatchPrintJob(
  intent: PrintIntent,
  payload: PrintJobPayload,
  opts: {
    terminalId?: string;
    config?: HardwareHubConfig;
    paymentMethod?: "CASH" | "SPLIT" | "VISA" | "DEBT" | "CLIQ";
  } = {},
): Promise<DispatchResult> {
  const config = opts.config ?? loadHardwareHubConfig();
  const slot = resolveSlot(intent, config);
  const paymentContext: PaymentAwareContext = {
    paymentMethod: opts.paymentMethod,
    autoOpenDrawer: true,
  };
  const kickDrawer = intentKicksDrawer(intent, config, paymentContext);

  // ── Drawer kick (independent of printing) ───────────────────────────
  let kickedDrawer = false;
  let drawerOk = true;
  if (kickDrawer) {
    kickedDrawer = true;
    // Pulse the drawer from the hub's own wiring config (com/baud/pin); no
    // chooser is ever opened here — the port is authorized once in the
    // Hardware Hub UI (Electron picks the COM, browser a Web Serial port).
    drawerOk = await openCashDrawer(
      {
        baudRate: config.drawer.baudRate,
        pin: config.drawer.pin,
        comPort: config.drawer.comPort || undefined,
      },
      opts.terminalId,
    );
  }

  // ── Print routing ───────────────────────────────────────────────────
  const slotEnabled = slot.enabled;
  if (!payload.html) {
    // Nothing to print and none requested; report the drawer decision only.
    return {
      intent,
      slotId: slot.id,
      printed: false,
      attempted: false,
      kickedDrawer,
      drawerOk,
      skippedPrint: true,
    };
  }

  // Graphical intents print a rendered HTML document — never a raw label
  // buffer. Refuse anything that is not markup so a TSPL/ESC-POS command
  // string can never be dispatched as a receipt (it must go through the
  // dedicated BARCODE label path instead).
  if (GRAPHICAL_INTENTS.has(intent) && !looksLikeHtmlDocument(payload.html)) {
    console.warn("[hardware-dispatch] Blocked non-HTML payload for graphical intent", intent);
    return {
      intent,
      slotId: slot.id,
      printed: false,
      attempted: true,
      kickedDrawer,
      drawerOk,
      error: "non_html_payload_for_graphical_intent",
    };
  }

  if (!slotEnabled) {
    return {
      intent,
      slotId: slot.id,
      printed: false,
      attempted: true,
      kickedDrawer,
      drawerOk,
      error: "printer_slot_disabled",
    };
  }

  const printerKind: PrinterKind = slot.kind;
  const printerName = slot.deviceName || undefined;

  try {
    if (slot.kind === "THERMAL" && isElectron()) {
      // Zero-fallback silent bridge for the checkout lane.
      const ok = await printReceiptSilently({ html: payload.html, printerName, printerKind });
      return {
        intent,
        slotId: slot.id,
        printed: ok,
        attempted: true,
        kickedDrawer,
        drawerOk,
        error: ok ? undefined : "print_failed",
      };
    }

    // LABEL / A4 / browser-THERMAL: use the smart three-tier chain.
    const printed = await smartPrint({
      terminalId: opts.terminalId ?? "",
      jobType: (payload.jobType as "RECEIPT" | "INVOICE" | "Z_REPORT" | "X_REPORT") ?? "RECEIPT",
      renderedHtml: payload.html,
      shift: payload.shift,
      printerKind,
      printerName,
      onFallback: (fallbackHtml) => {
        if (fallbackHtml) void printInBrowser(fallbackHtml);
      },
    });
    return {
      intent,
      slotId: slot.id,
      printed,
      attempted: true,
      kickedDrawer,
      drawerOk,
      error: printed ? undefined : "browser_dialog",
    };
  } catch (error) {
    return {
      intent,
      slotId: slot.id,
      printed: false,
      attempted: true,
      kickedDrawer,
      drawerOk,
      error: error instanceof Error ? error.message : "dispatch_failed",
    };
  }
}
