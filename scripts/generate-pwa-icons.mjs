// generate-pwa-icons.mjs
// Pure-Node PWA icon generator (no image deps). Produces deterministic PNG
// icons + a favicon.ico from the MAKEEN brand palette:
//   - emerald primary #10b981, white "M" monogram
// Outputs:
//   public/icons/icon-192.png            192x192 rounded (purpose: any)
//   public/icons/icon-512.png            512x512 rounded (purpose: any)
//   public/icons/icon-512-maskable.png   512x512 full-bleed (purpose: maskable)
//   public/icons/apple-touch-icon.png    180x180 full-bleed (iOS, no alpha)
//   app/favicon.ico                      16/32/48 multi-size ICO
//
// Run: node scripts/generate-pwa-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const BRAND_EMERALD = [16, 185, 129]; // #10b981
const BRAND_WHITE = [255, 255, 255];

// ---------------------------------------------------------------- PNG/ICO I/O
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an RGBA pixel buffer (Uint8Array, width*height*4) as a PNG. */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** Pack PNG blobs into an ICO container (multi-size favicon). */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bit count
    e.writeUInt32LE(png.length, 8); // bytes in resource
    e.writeUInt32LE(offset, 12); // image offset
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

// ------------------------------------------------------------- shape helpers
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function inRoundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = clamp(px, x0 + r, x1 - r);
  const cy = clamp(py, y0 + r, y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function segDist2(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / len2;
  t = clamp(t, 0, 1);
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return dx * dx + dy * dy;
}

// Glyph: a white "M" monogram — two vertical stems + a center chevron.
function inGlyph(px, py, size) {
  const gTop = 0.27 * size;
  const gBot = 0.73 * size;
  const stemLX = 0.3 * size;
  const stemRX = 0.7 * size;
  const stemHalf = 0.028 * size;
  const dip = 0.6 * size;
  const chevHalf = 0.03 * size;

  if (py >= gTop && py <= gBot) {
    if (px >= stemLX - stemHalf && px <= stemLX + stemHalf) return true;
    if (px >= stemRX - stemHalf && px <= stemRX + stemHalf) return true;
  }
  const onA = segDist2(px, py, stemLX, gTop, 0.5 * size, dip);
  const onB = segDist2(px, py, 0.5 * size, dip, stemRX, gTop);
  return Math.min(onA, onB) <= chevHalf * chevHalf;
}

/**
 * Render one icon.
 * @param size   output square size in px
 * @param rounded true => emerald rounded-rect on transparent corners
 * @param alpha  false => opaque everywhere (iOS / maskable)
 */
function renderIcon(size, { rounded = true, alpha = false }) {
  const SS = 4; // supersampling factor
  const out = new Uint8Array(size * size * 4);
  const pad = rounded ? 0.05 * size : 0;
  const radius = rounded ? 0.2 * size : 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0;
      let fgCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const inBg = rounded
            ? inRoundedRect(px, py, pad, pad, size - pad, size - pad, radius)
            : true;
          if (inBg) {
            bgCov += 1;
            if (inGlyph(px, py, size)) fgCov += 1;
          }
        }
      }
      const total = SS * SS;
      const a = bgCov / total;
      const f = fgCov / total;
      const r = BRAND_EMERALD[0] + (BRAND_WHITE[0] - BRAND_EMERALD[0]) * f;
      const g = BRAND_EMERALD[1] + (BRAND_WHITE[1] - BRAND_EMERALD[1]) * f;
      const b = BRAND_EMERALD[2] + (BRAND_WHITE[2] - BRAND_EMERALD[2]) * f;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r);
      out[i + 1] = Math.round(g);
      out[i + 2] = Math.round(b);
      out[i + 3] = alpha ? 255 : Math.round(a * 255);
    }
  }
  return encodePng(size, size, out);
}

const icons = [
  { file: "public/icons/icon-192.png", size: 192, rounded: true, alpha: false },
  { file: "public/icons/icon-512.png", size: 512, rounded: true, alpha: false },
  { file: "public/icons/icon-512-maskable.png", size: 512, rounded: false, alpha: true },
  { file: "public/icons/apple-touch-icon.png", size: 180, rounded: false, alpha: true },
];

for (const icon of icons) {
  const png = renderIcon(icon.size, icon);
  const outPath = join(ROOT, icon.file);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  console.log(`wrote ${icon.file} (${icon.size}x${icon.size}, ${png.length} bytes)`);
}

const favicon = encodeIco(
  [16, 32, 48].map((size) => ({
    size,
    png: renderIcon(size, { rounded: true, alpha: false }),
  })),
);
writeFileSync(join(ROOT, "app/favicon.ico"), favicon);
console.log(`wrote app/favicon.ico (${favicon.length} bytes)`);
