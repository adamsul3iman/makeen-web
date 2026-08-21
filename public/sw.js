/*!
 * MAKEEN POS — Service Worker
 *
 * Cache strategy (strictly layered so the offline-first IndexedDB sync
 * pipeline and every /api route are NEVER intercepted):
 *
 *   PASS-THROUGH (browser default, no respondWith):
 *     - any cross-origin request (Supabase REST, external fonts/hosts)
 *     - any non-GET request (POST sync/ISTD/RSC payloads, etc.)
 *     - same-origin /api/* (all route handlers + the sync drain endpoint)
 *     - /sw.js itself
 *
 *   CACHE-FIRST (immutable, content-hashed by Next):
 *     - /_next/static/*  (JS, CSS, fonts, RSC payloads)
 *
 *   STALE-WHILE-REVALIDATE:
 *     - public assets (icons, logo, manifest) — served instantly, refreshed
 *       in the background so redeploys converge without a stale-forever icon
 *     - /_next/image* optimizer responses
 *
 *   NETWORK-FIRST (app shell):
 *     - navigations (document requests) — fresh when online, falls back to
 *       the last cached document, then to the cached "/" shell when offline.
 *
 * Version this file's CACHE_VERSION when the cache policy changes so old
 * caches are purged on activate.
 */
const CACHE_VERSION = "2026-08-16-v1";
const CACHE_SHELL = `pos-shell-${CACHE_VERSION}`;
const CACHE_STATIC = `pos-static-${CACHE_VERSION}`;
const CACHE_ASSETS = `pos-assets-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",
  "/login",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon.png",
  "/logo.png",
];

const NAV_FALLBACK_TIMEOUT_MS = 8000;

function shouldBypass(url) {
  if (url.origin !== self.location.origin) return true; // Supabase + externals
  if (url.pathname.startsWith("/api/")) return true;
  if (url.pathname === "/sw.js") return true;
  return false;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("navigation timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function putSafely(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch {
    // Unstorable response (Vary:*, opaque, quota…) — never fatal.
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_STATIC);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    await putSafely(cache, request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_ASSETS);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        await putSafely(cache, request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    void refresh; // serve now, update in the background
    return cached;
  }
  const fresh = await refresh;
  return fresh || new Response("", { status: 504 });
}

async function navigationResponse(request) {
  const cache = await caches.open(CACHE_SHELL);
  try {
    const fresh = await withTimeout(fetch(request), NAV_FALLBACK_TIMEOUT_MS);
    if (fresh && fresh.ok) {
      await putSafely(cache, request, fresh.clone());
      return fresh;
    }
    if (fresh) return fresh;
  } catch {
    // offline / unreachable — fall through to the cached shell
  }
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const shell = await cache.match("/");
  if (shell) return shell;
  return new Response("MAKEEN POS غير متصل بالإنترنت", { status: 503 });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_SHELL);
      await Promise.all(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => {})),
      );
      self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("pos-") && !key.endsWith(CACHE_VERSION))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (shouldBypass(url)) return; // network-only: /api/*, sw.js, Supabase, externals

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/_next/image")
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
