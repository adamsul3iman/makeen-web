"use client";

import { useEffect } from "react";
import { usePosStore } from "@/store/usePosStore";
import { shouldCoalesceScan } from "@/lib/scanCoalesce";
import { emitPosSound } from "@/lib/posSound";

const SCAN_MAX_GAP_MS = 60;
const SCAN_MAX_DURATION_MS = 600;
const SCAN_MIN_LENGTH = 3;
const SCAN_AVG_KEYS_MS = 30;
const SCAN_MAX_BUFFER = 128;

const isEditableTarget = (el: Element | null): boolean => {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable === true;
};

/**
 * Global hardware-scanner listener for the admin purchases screen.
 *
 * Same wedge-burst fingerprinting as the POS hook (machine-fast keystroke
 * burst terminated by Enter), but scoped to the goods-receiving flow. When a
 * code is captured and it resolves against the cache-resident `barcodeIndex`
 * loaded in `usePosStore`, `onScan` is invoked so the page can append/merge a
 * purchase line. This keeps entry keyboard/scanner-driven with no need for a
 * mouse on the hot path.
 */
export function usePurchasesScanner(onScan: (code: string) => void): void {
  useEffect(() => {
    let buffer: string[] = [];
    let start = 0;
    let last = 0;
    let lastCommittedCode: string | null = null;
    let lastCommittedAt = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      // A focused field (the dedicated manual barcode input, a qty box, the
      // supplier picker, ...) hands control back to the browser. The manual
      // input path handles its own submit-Enter.
      if (isEditableTarget(document.activeElement)) return;

      if (e.key === "Enter" || e.key === "Tab") {
        if (buffer.length >= SCAN_MIN_LENGTH) {
          const store = usePosStore.getState();
          const now = performance.now();
          const avg = (now - start) / buffer.length;
          if (avg < SCAN_AVG_KEYS_MS && now - start <= SCAN_MAX_DURATION_MS) {
            e.preventDefault();
            const code = buffer.join("");
            if (!shouldCoalesceScan(lastCommittedCode, lastCommittedAt, code, now)) {
              if (!store.barcodeIndex[code]) {
                emitPosSound("ERROR");
              } else {
                onScan(code);
              }
            }
            lastCommittedCode = code;
            lastCommittedAt = now;
          }
        }
        buffer = [];
        start = 0;
        last = 0;
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

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onScan]);
}
