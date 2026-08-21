"use client";

import { useEffect } from "react";
import { anyPosModalOpen, usePosStore } from "@/store/usePosStore";
import {
  loadDeviceHardwareSettings,
  scannerAcceptsSubmitKey,
} from "@/lib/deviceHardware";
import { shouldCoalesceScan } from "@/lib/scanCoalesce";
import { emitPosSound } from "@/lib/posSound";

const SCAN_MAX_GAP_MS = 60;
const SCAN_MAX_DURATION_MS = 600;
const SCAN_MIN_LENGTH = 3;
const SCAN_AVG_KEYS_MS = 30;
const SCAN_MAX_BUFFER = 128;

/**
 * A machine fast, still-fresh keystroke burst — the fingerprint of a USB
 * keyboard-wedge barcode scanner (avg < 30ms per key, whole burst ≤ 600ms).
 */
export function isWedgeBurst(opts: {
  length: number;
  start: number;
  now: number;
  avgKeyMs: number;
}): boolean {
  if (opts.length < SCAN_MIN_LENGTH) return false;
  if (opts.avgKeyMs >= SCAN_AVG_KEYS_MS) return false;
  if (opts.now - opts.start > SCAN_MAX_DURATION_MS) return false;
  return true;
}

const isEditableTarget = (el: Element | null): boolean => {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable === true;
};

/**
 * Global hardware-scanner listener.
 *
 * Barcode scanners behave as fast keyboards: a burst of keydown events
 * (typically a few ms apart) terminated by Enter. When no text field is
 * focused we capture the burst, verify it is machine-fast, and push the
 * code straight into the cart via `scanBarcode`.
 *
 * Guard rails:
 *  - Any focused input/textarea/select (customer-name field, the manual
 *    barcode input, PIN pad...) hands control back to the browser.
 *  - Modifier keys and auto-repeat are ignored.
 *  - The register must be OPEN and a cashier must be unlocked.
 *  - No modal may be open.
 *  - The burst must be faster than human typing (avg < 30ms per key) and
 *    still fresh (≤ 600ms total), so a lost terminating Enter never commits
 *    a stale code later.
 */
export function useBarcodeScanner(): void {
  useEffect(() => {
    let buffer: string[] = [];
    let start = 0;
    let last = 0;
    let lastCommittedCode: string | null = null;
    let lastCommittedAt = 0;

    // Wedge burst tracking for CAPTURE phase: a scan typed while a modal's
    // money field is focused is indistinguishable from typing until its
    // Enter/Tab terminator arrives, so we shadow the burst here. When the
    // terminator proves the burst was machine-fast, we swallow it so the
    // modal can never submit a barcode as cash given / discount value.
    let wedgeBuffer: string[] = [];
    let wedgeStart = 0;
    let wedgeLast = 0;

    const onCaptureKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;

      const store = usePosStore.getState();
      // Only guard against wedge scans while a modal is open — in normal
      // (no-modal) scanning the main handler below owns the burst.
      if (!anyPosModalOpen(store)) return;
      // The wedge only matters when it landed inside a field (cash given,
      // discount, delivery fee, customer...). Capture the terminator before
      // the field's own Enter handler and the browser's default submit.
      if (!isEditableTarget(document.activeElement)) return;

      if (e.key === "Enter" || e.key === "Tab") {
        const now = performance.now();
        const avg = wedgeBuffer.length > 0 ? (now - wedgeStart) / wedgeBuffer.length : Infinity;
        if (
          isWedgeBurst({
            length: wedgeBuffer.length,
            start: wedgeStart,
            now,
            avgKeyMs: avg,
          })
        ) {
          e.preventDefault();
          e.stopPropagation();
          emitPosSound("ERROR");
          console.warn("تم تجاهل مسح ضوئي داخل نافذة إدخال المبلغ/الخصم");
        }
        wedgeBuffer = [];
        wedgeStart = 0;
        wedgeLast = 0;
        return;
      }

      if (e.key.length !== 1) return;

      const now = performance.now();
      if (wedgeBuffer.length === 0 || now - wedgeLast > SCAN_MAX_GAP_MS) {
        wedgeBuffer = [];
        wedgeStart = now;
      }
      wedgeLast = now;
      wedgeBuffer.push(e.key);

      if (
        wedgeBuffer.length >= SCAN_MAX_BUFFER ||
        now - wedgeStart > SCAN_MAX_DURATION_MS
      ) {
        wedgeBuffer = [];
        wedgeStart = 0;
        wedgeLast = 0;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;

      const store = usePosStore.getState();
      if (store.shiftState.status !== "OPEN") return;
      // Register PIN-locked (no cashier session): a scan must never add items
      // behind the lock screen.
      if (!store.currentCashier) return;
      // No modal may be open: a scan must never fire behind a dialog
      // (checkout, hold, close-shift, previous-invoices, audit log, ...).
      if (anyPosModalOpen(store)) return;
      if (isEditableTarget(document.activeElement)) return;

      // Settings are read from localStorage only on a potential submit key —
      // a real scanner burst hits this handler for every character, so doing
      // a storage read + JSON.parse per keydown would burn I/O on the hot path.
      if (e.key === "Enter" || e.key === "Tab") {
        const hardware = loadDeviceHardwareSettings(store.activeTerminalId);
        if (scannerAcceptsSubmitKey(e.key, hardware.scannerSubmitKey)) {
          if (buffer.length >= SCAN_MIN_LENGTH) {
            const now = performance.now();
            const avg = (now - start) / buffer.length;
            // Machine-fast burst AND fresh: a stale half-captured burst whose
            // terminating Enter was lost must never be committed later.
            if (avg < SCAN_AVG_KEYS_MS && now - start <= SCAN_MAX_DURATION_MS) {
              e.preventDefault();
              const code = buffer.join("");
              // A single trigger on cheap scanners can double-read and transmit
              // the same code twice within a few ms: coalesce so the item is
              // added once (a human cannot re-scan inside the window).
              if (!shouldCoalesceScan(lastCommittedCode, lastCommittedAt, code, now)) {
                store.scanBarcode(code);
              }
              lastCommittedCode = code;
              lastCommittedAt = now;
            }
          }
          buffer = [];
          start = 0;
          last = 0;
        }
        return;
      }

      if (e.key.length !== 1) return;

      const now = performance.now();
      if (buffer.length === 0 || now - last > SCAN_MAX_GAP_MS) {
        buffer = [];
        start = now;
      }
      last = now;
      buffer.push(e.key);

      if (
        buffer.length >= SCAN_MAX_BUFFER ||
        now - start > SCAN_MAX_DURATION_MS
      ) {
        buffer = [];
        start = 0;
        last = 0;
      }
    };

    window.addEventListener("keydown", onCaptureKeyDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onCaptureKeyDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
