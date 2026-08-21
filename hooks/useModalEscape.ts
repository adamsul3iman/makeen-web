"use client";

import { useEffect } from "react";

/**
 * Registers a global keydown listener that calls `onClose` when Escape is
 * pressed.  Safe for SSR (effect-only) and cleans up on unmount.
 */
export function useModalEscape(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}
