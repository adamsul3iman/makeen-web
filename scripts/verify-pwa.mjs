// verify-pwa.mjs
// Static verification of the MAKEEN POS PWA layer — no Playwright, no
// Lighthouse, no network. Checks the artifacts that a Lighthouse audit
// (or a manual DevTools review) would exercise:
//   1. manifest.webmanifest — required fields, icon entries + purposes
//   2. icon files — exist, valid PNG signature, correct dimensions
//   3. public/sw.js — bypass gates, cache policy, update flow hooks
//   4. wiring — layout.tsx metadata/viewport/lang/dir, ServiceWorkerRegister,
//      next.config.ts no-cache for /sw.js
//
// Run: node scripts/verify-pwa.mjs
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let failures = 0;
let checks = 0;

function check(ok, label, detail = "") {
  checks++;
  if (ok) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function read(root, file) {
  const p = join(root, file);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Parse PNG IHDR width/height; null if not a valid PNG. */
function pngDimensions(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

console.log("\n[1/4] manifest.webmanifest");
const manifestRaw = read(ROOT, "app/manifest.webmanifest");
check(manifestRaw !== null, "app/manifest.webmanifest exists");
let manifest = null;
if (manifestRaw) {
  try {
    manifest = JSON.parse(manifestRaw);
    check(true, "manifest parses as JSON");
  } catch {
    check(false, "manifest parses as JSON", "invalid JSON");
  }
}
if (manifest) {
  check(manifest.name === "MAKEEN POS", "name", `got "${manifest.name}"`);
  check(manifest.short_name === "POS", "short_name", `got "${manifest.short_name}"`);
  check(manifest.start_url === "/", "start_url", `got "${manifest.start_url}"`);
  check(manifest.scope === "/", "scope", `got "${manifest.scope}"`);
  check(manifest.display === "standalone", "display", `got "${manifest.display}"`);
  check(manifest.display_override?.includes("standalone") === true, "display_override", `got ${JSON.stringify(manifest.display_override)}`);
  check(manifest.orientation === "any", "orientation", `got "${manifest.orientation}"`);
  check(manifest.theme_color === "#10b981", "theme_color", `got "${manifest.theme_color}"`);
  check(manifest.background_color === "#fafafa", "background_color", `got "${manifest.background_color}"`);
  check(manifest.lang === "ar", "lang", `got "${manifest.lang}"`);
  check(manifest.dir === "rtl", "dir", `got "${manifest.dir}"`);
  check(Array.isArray(manifest.icons) && manifest.icons.length >= 3, "icons array", `${manifest.icons?.length ?? 0} entries`);

  const byPurpose = (purpose) => (manifest.icons ?? []).filter((i) => (i.purpose ?? "any").split(/\s+/).includes(purpose));
  const anyIcon = byPurpose("any").find((i) => i.sizes === "192x192" && i.type === "image/png");
  const any512 = byPurpose("any").find((i) => i.sizes === "512x512" && i.type === "image/png");
  const maskable = byPurpose("maskable").find((i) => i.sizes === "512x512" && i.type === "image/png");
  check(!!anyIcon, "any icon 192x192 png", anyIcon?.src ?? "missing");
  check(!!any512, "any icon 512x512 png", any512?.src ?? "missing");
  check(!!maskable, "maskable icon 512x512 png", maskable?.src ?? "missing");
}

console.log("\n[2/4] icon files");
const iconSpecs = [
  ["public/icons/icon-192.png", 192],
  ["public/icons/icon-512.png", 512],
  ["public/icons/icon-512-maskable.png", 512],
  ["public/icons/apple-touch-icon.png", 180],
];
for (const [file, size] of iconSpecs) {
  const p = join(ROOT, file);
  if (!existsSync(p)) {
    check(false, `${file} exists`, "missing");
    continue;
  }
  const dim = pngDimensions(readFileSync(p));
  check(dim !== null, `${file} is a valid PNG`);
  if (dim) check(dim.width === size && dim.height === size, `${file} dimensions`, `${dim.width}x${dim.height}`);
}
check(existsSync(join(ROOT, "app/favicon.ico")), "app/favicon.ico exists");

console.log("\n[3/4] public/sw.js");
const sw = read(ROOT, "public/sw.js");
check(sw !== null, "public/sw.js exists");
if (sw) {
  const require = (pat, label) => check(new RegExp(pat, "m").test(sw), label);
  require("CACHE_VERSION\\s*=\\s*[\"']2026-08-16-v1[\"']", "CACHE_VERSION pinned");
  require("skipWaiting", "skipWaiting() on install");
  require("clients\\.claim", "clients.claim() in activate");
  require("SKIP_WAITING", "SKIP_WAITING message hook");
  require("shouldBypass", "shouldBypass() gate");
  require("url\\.origin !== self\\.location\\.origin", "cross-origin bypassed");
  require("url\\.pathname\\.startsWith\\(\"/api/\"\\)", "same-origin /api/* bypassed");
  require("request\\.method !== \"GET\"", "non-GET bypassed");
  require("if \\(shouldBypass\\(url\\)\\) return;", "network-only return for bypassed");
  require("pos-shell", "navigation shell cache");
  require("pos-static", "static asset cache");
  require("pos-assets", "public asset cache");
  require("cache\\.match\\(request\\)", "fallback via cache.match");
  require("setTimeout", "navigation timeout fallback");
  require("503", "offline 503 fallback");
}

console.log("\n[4/4] wiring");
const layout = read(ROOT, "app/layout.tsx");
check(layout !== null, "app/layout.tsx exists");
if (layout) {
  const require = (pat, label) => check(new RegExp(pat, "m").test(layout), label);
  require('manifest: "/manifest.webmanifest"', "metadata.manifest");
  require("applicationName", "metadata.applicationName");
  require("appleWebApp", "metadata.appleWebApp");
  require('statusBarStyle: "black-translucent"', "appleWebApp.statusBarStyle");
  require("formatDetection", "metadata.formatDetection");
  require('lang="ar"', "html lang=ar");
  require('dir="rtl"', "html dir=rtl");
  require("themeColor: \"#10b981\"", "viewport.themeColor");
  require("viewportFit: \"cover\"", "viewport.viewportFit");
  require("ServiceWorkerRegister", "<ServiceWorkerRegister /> rendered");
  require('from "@/components/pwa/ServiceWorkerRegister"', "ServiceWorkerRegister import");
}

const register = read(ROOT, "components/pwa/ServiceWorkerRegister.tsx");
check(register !== null, "components/pwa/ServiceWorkerRegister.tsx exists");
if (register) {
  const require = (pat, label) => check(new RegExp(pat, "m").test(register), label);
  require('register\\(\"/sw\\.js"', "registers /sw.js");
  require('updateViaCache: "none"', "updateViaCache none");
  require('NODE_ENV !== "production"', "production-only");
}

const cfg = read(ROOT, "next.config.ts");
check(cfg !== null, "next.config.ts exists");
if (cfg) {
  const require = (pat, label) => check(new RegExp(pat, "m").test(cfg), label);
  require('source: "/sw.js"', "sw.js header rule");
  require("no-cache, no-store, must-revalidate", "sw.js Cache-Control no-store");
}

console.log(`\n${checks} checks, ${failures} failure${failures === 1 ? "" : "s"}`);
if (failures > 0) process.exit(1);
console.log("PWA layer OK.");
