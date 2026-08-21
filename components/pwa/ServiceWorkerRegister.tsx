"use client";

import { useEffect } from "react";

/**
 * Registers the MAKEEN POS service worker (public/sw.js) in production only.
 *
 * The worker must never run in development: `next dev` serves un-hashed,
 * hot-reloading assets that a cache-first worker would serve stale forever.
 *
 * Update flow: the new worker calls skipWaiting() and claims open clients, so
 * a deployment takes effect on the next page load. The tab is deliberately
 * NOT auto-reloaded mid-session — a running register must never be interrupted
 * during an active sale.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });

        const requestActivation = (worker: ServiceWorker) => {
          worker.postMessage({ type: "SKIP_WAITING" });
        };

        if (registration.waiting) requestActivation(registration.waiting);

        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              requestActivation(worker);
            }
          });
        });
      } catch {
        // Registration is best-effort: a register offline on first boot must
        // never throw and break the POS.
      }
    };

    void register();
  }, []);

  return null;
}
