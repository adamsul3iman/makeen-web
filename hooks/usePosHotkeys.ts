"use client";

import { useEffect } from "react";
import { anyPosModalOpen, usePosStore } from "@/store/usePosStore";

const HOTKEYS = new Set(["F2", "F4", "F6", "F7", "F8", "F9", "F10"]);

/**
 * Global cashier hotkeys:
 *  - Ctrl+K / ⌘K: toggle global smart product-search overlay (open + search by
 *    name/barcode, or close if already open)
 *  - Ctrl+Shift+A: toggle the Admin Hub (store-owner session only — cashier
 *    PIN sessions never see it): quick-links grid to the back office
 *  - F2: open checkout modal (F2 again closes it)
 *  - F4: hold current invoice
 *  - F6: toggle Return Mode (المرتجعات)
 *  - F7: open Debt Settlement (سداد الذمم) modal
 *  - F8: cancel/clear invoice (or close any open modal)
 *  - F9: toggle held-invoices modal
 *  - F10: toggle close-shift (Z-report) modal
 *  - Esc: close the topmost open modal
 *
 * Guards:
 *  - The handler bails out before ANY key property is read when there is no
 *    store binding or cashier session (register closed or locked) or while a
 *    shift-close is in flight, so it can never crash mid handover as the UI
 *    unmounts toward /login. The register is locked behind the Open-Shift /
 *    RegisterGate screen and no sales/actions may be triggered.
 *  - All keys are no-ops while the shift is CLOSED: the register is locked
 *    behind the Open-Shift screen and no sales/actions may be triggered.
 *    (Ctrl+Shift+A is exempt: the Admin Hub is pure navigation and must stay
 *    reachable before a shift is open.)
 *  - All keys are no-ops while the register is PIN-locked (no cashier
 *    session): nothing may fire behind the lock screen.
 *  - Modal-opening actions (F2/F7/F9/F10) and cart actions (F4/F6) are
 *    no-ops while ANY modal is open — only toggling the SAME modal closed
 *    (or F8 close-all / Esc) is allowed, so nothing ever fires "behind" a
 *    dialog or clears the cart while the checkout is up.
 *
 * F-keys are hard for keyboards to produce accidentally while typing
 * digits, so they never collide with barcode input. Every handled key
 * calls preventDefault() to stop browser defaults (F5 refresh etc.).
 */
export function usePosHotkeys(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac =
        typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);
      const store = usePosStore.getState();

      // Register closed or locked (no store binding, no cashier session) or a
      // shift-close in flight: every hotkey is a no-op. Nothing may fire
      // behind the Open-Shift / RegisterGate screens or mid-handover, when the
      // cashier session is already dropped and the UI is unmounting to /login.
      if (!store.currentStore || !store.currentCashier || store.isCompleting) return;
      // Synthetic/edge keydown events can arrive without a usable `key`
      // (e.g. during an in-flight navigation or IME composition). Never assume
      // a well-formed string before calling toLowerCase/toUpperCase below.
      if (typeof e.key !== "string") return;

      // Ctrl+Shift+A: toggle the Admin Hub. Must fire before the generic
      // modifier guard below (Ctrl+Shift is normally rejected) and only for
      // an authenticated store-owner session — cashiers never get it.
      if (
        e.key.toLowerCase() === "a" &&
        e.ctrlKey &&
        e.shiftKey &&
        !e.metaKey &&
        !e.altKey &&
        !isMac
      ) {
        if (e.repeat) return;
        if (!store.adminSession) return;
        if (!store.currentCashier) return;
        if (store.isAdminHubOpen) {
          e.preventDefault();
          store.closeAdminHub();
          return;
        }
        if (anyPosModalOpen(store)) return;
        e.preventDefault();
        store.openAdminHub();
        return;
      }

      // Ctrl+K / ⌘K (macOS): toggle the global smart product-search overlay.
      // Handled before the modifier guard below so the accelerator can fire
      // even though Cmd/Ctrl are normally rejected.
      // The Arabic keyboard maps the K key position to `ن` (U+0646), so both
      // characters must be accepted for the shortcut to work regardless of the
      // active keyboard language (Ctrl+K in English, Ctrl+ن in Arabic).
      const isSearchAccel =
        (e.key.toLowerCase() === "k" || e.key === "ن") &&
        (isMac ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && !e.metaKey && !e.altKey);
      if (isSearchAccel) {
        if (e.repeat) return;
        if (store.shiftState.status !== "OPEN") return;
        if (!store.currentCashier) return;
        if (store.isSmartSearchOpen) {
          e.preventDefault();
          store.closeSmartSearch();
          return;
        }
        if (anyPosModalOpen(store)) return;
        e.preventDefault();
        store.openSmartSearch();
        return;
      }

      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;

      if (e.key === "Escape") {
        if (!store.currentCashier) return;
        // Close the topmost modal (smart search / admin hub sit on top;
        // otherwise the most recently stacked action dialog). The secondary
        // auth password gate handles its own Escape key.
        const closeTop = [
          store.isSmartSearchOpen ? () => store.closeSmartSearch() : null,
          store.isAdminHubOpen ? () => store.closeAdminHub() : null,
          store.isCheckoutModalOpen ? () => store.closeCheckout() : null,
          store.isHoldModalOpen ? () => store.closeHoldModal() : null,
          store.isCloseShiftModalOpen ? () => store.closeCloseShiftModal() : null,
          store.isDebtSettlementModalOpen ? () => store.closeDebtSettlementModal() : null,
          store.isExpenseModalOpen ? () => store.closeExpenseModal() : null,
          store.isPreviousInvoicesModalOpen ? () => store.closePreviousInvoicesModal() : null,
          store.isAuditLogOpen ? () => store.closeAuditLogModal() : null,
        ].find((fn) => fn !== null);
        if (closeTop) {
          e.preventDefault();
          closeTop();
        }
        return;
      }

      const key = e.key.toUpperCase();
      if (!HOTKEYS.has(key)) return;

      const anyModalOpen = anyPosModalOpen(store);

      // Register locked until a shift is open.
      if (store.shiftState.status !== "OPEN") return;
      // No cashier session (register PIN-locked): no action may fire.
      if (!store.currentCashier) return;

      switch (key) {
        case "F2":
          e.preventDefault();
          // Only open the checkout when no other modal is up; toggling it
          // closed is always allowed.
          if (store.isCheckoutModalOpen) store.closeCheckout();
          else if (!anyModalOpen) store.openCheckout();
          break;
        case "F4":
          e.preventDefault();
          // Never hold/clear the cart "behind" an open modal.
          if (!anyModalOpen) store.holdInvoice();
          break;
        case "F6":
          e.preventDefault();
          // Never flip return mode behind an open modal.
          if (!anyModalOpen) store.requestReturnModeToggle();
          break;
        case "F7":
          e.preventDefault();
          if (store.isDebtSettlementModalOpen) store.closeDebtSettlementModal();
          else if (!anyModalOpen) store.openDebtSettlementModal();
          break;
        case "F8":
          e.preventDefault();
          if (anyModalOpen) {
            store.closeCheckout();
            store.closeHoldModal();
            store.closeCloseShiftModal();
            store.closeShiftDetailsModal();
            store.closeDebtSettlementModal();
            store.closeExpenseModal();
            store.closeCashMovementModal();
            store.closeSmartSearch();
            store.closeAdminHub();
            store.closePreviousInvoicesModal();
            store.closeAuditLogModal();
          } else {
            store.clearInvoice();
          }
          break;
        case "F9":
          e.preventDefault();
          if (store.isHoldModalOpen) store.closeHoldModal();
          else if (!anyModalOpen) store.openHoldModal();
          break;
        case "F10":
          e.preventDefault();
          if (store.isCloseShiftModalOpen) store.closeCloseShiftModal();
          else if (!anyModalOpen) store.openCloseShiftModal();
          break;
        default:
          // Any other hotkey is a no-op while a modal is open: it must not
          // fire "behind" the dialog (e.g. F4 holding an invoice while the
          // checkout modal is up).
          if (anyModalOpen) return;
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
