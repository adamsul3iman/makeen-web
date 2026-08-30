/**
 * Build `lib/printFonts.ts` — embeds Tajawal + Cairo (Arabic & Latin subsets)
 * as base64 data-URIs so printed receipts are 100% offline: the hidden
 * Electron print window and the browser iframe both load an isolated `data:`
 * document that can never reach fonts.googleapis.com (the source of the ~30s
 * network hang on AirGapped/POS machines).
 *
 * The generated module is checked in so `next build` stays deterministic and
 * offline. Regenerate with:  npm run fonts:build
 *
 * Source: Fontsource CDN (https://cdn.jsdelivr.net/npm/@fontsource/...).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "lib", "printFonts.ts");
const CDN = "https://cdn.jsdelivr.net/npm";

// Weights actually rendered on the receipt: 400 = body copy, 700 = labels,
// 900 = totals/header emphasis. The thermal receipt component hard-codes these
// weights (no configurable weight selector), so embedding a lean superset
// guarantees the printed slip matches the on-screen preview without shipping
// unused face data.
const TAJAWAL_WEIGHTS = [400, 700, 900];
const CAIRO_WEIGHTS = [400, 700, 900];

const UNICODE_RANGE = {
  arabic:
    "U+0600-06FF,U+0750-077F,U+0870-089F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF",
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
};

async function fetchBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

function buildFamily(family, version, weights) {
  return Promise.all(
    weights.map(async (weight) => {
      const subsets = {};
      for (const subset of Object.keys(UNICODE_RANGE)) {
        const file = `${family.toLocaleLowerCase()}-${subset}-${weight}-normal.woff2`;
        const url = `${CDN}/@fontsource/${family.toLocaleLowerCase()}@${version}/files/${file}`;
        subsets[subset] = await fetchBase64(url);
      }
      return { family, weight, subsets };
    }),
  );
}

async function main() {
  console.log("[fonts] Fetching Tajawal + Cairo woff2 subsets...");
  const [tajawal, cairo] = await Promise.all([
    buildFamily("Tajawal", "5.1.1", TAJAWAL_WEIGHTS),
    buildFamily("Cairo", "5.1.0", CAIRO_WEIGHTS),
  ]);

  const entries = [...tajawal, ...cairo].map((meta) =>
    Object.entries(meta.subsets).map(([subset, b64]) => {
      const face =
        `@font-face{font-family:'${meta.family}';font-style:normal;font-weight:${meta.weight};font-display:block;unicode-range:${UNICODE_RANGE[subset]};src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
      return { key: `${meta.family}-${subset}-${meta.weight}`, face };
    }),
  );
  const flat = entries.flat();

  const content = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with:  npm run fonts:build
 * (Source: scripts/build-print-fonts.mjs → Fontsource CDN.)
 *
 * Tajawal + Cairo (Arabic & Latin subsets) embedded as base64 data-URIs.
 *
 * BOTH subsets are required: receipts render Arabic UI strings AND Western
 * numerals/amounts in dir="ltr" cells. The unicode-range split lets the
 * browser select the correct face per character, so numbers are NOT silently
 * switched to a system font on thermal paper.
 *
 * Injected into every self-contained print document via wrapHtml() so the
 * hidden Electron print window and the browser iframe never fetch a font
 * from the network.
 */
export const PRINT_FONT_FACES_CSS: string = \`
${flat.map((f) => f.face).join("\n")}
\`;
`;

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, content, "utf8");
  const kb = Math.round(Buffer.byteLength(content, "utf8") / 1024);
  console.log(`[fonts] Wrote ${OUT_FILE} (${kb} KiB, ${flat.length} faces)`);
}

main().catch((err) => {
  console.error("[fonts] Build failed:", err);
  process.exit(1);
});