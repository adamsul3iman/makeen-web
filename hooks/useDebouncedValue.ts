"use client";

import { useEffect, useState } from "react";

/**
 * Returns `value` after it has been stable for `delay` ms. Keeps expensive
 * recomputation (product search/filter) off the per-keystroke critical path
 * without adding latency to the controlled input itself.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
