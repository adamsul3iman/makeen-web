/**
 * Jordan ISTD cryptographic QR (JoFotara simplified tax invoice).
 *
 * The Jordanian standard embeds five fields in a Base64-encoded TLV byte
 * string — exactly what the ISTD Sanad verification app reads off a printed
 * receipt:
 *   tag 1 = Seller (Store) Name
 *   tag 2 = Tax / fiscal identification number (15-digit TIN)
 *   tag 3 = Issue timestamp (ISO 8601)
 *   tag 4 = Total amount incl. VAT (fixed 2 decimals, JOD)
 *   tag 5 = Tax (VAT) amount (fixed 2 decimals, JOD)
 *
 * Tags are single bytes; lengths use DER/BER short-form (< 128 bytes) and
 * long-form beyond, so Arabic UTF-8 seller names are safe. The output is the
 * Base64 of the raw TLV byte sequence — the value the tax authority and
 * fiscal scanners expect on the receipt.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Amount string used in the TLV: fixed 2 decimals, no negative zero. */
export function jordanAmount(n: number): string {
  const v = round2(n);
  if (Object.is(v, -0)) return "0.00";
  return v.toFixed(2);
}

/** Encode one TLV field (tag + length + UTF-8 value bytes). */
function tlvField(tag: number, value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  const length: number[] = [];
  if (bytes.length < 0x80) {
    length.push(bytes.length);
  } else if (bytes.length <= 0xff) {
    length.push(0x81, bytes.length);
  } else {
    length.push(0x82, (bytes.length >> 8) & 0xff, bytes.length & 0xff);
  }
  return [tag, ...length, ...bytes];
}

export interface JordanQrInput {
  /** Seller / store name printed above the QR. */
  sellerName: string;
  /** Jordan TIN (15 digits) — the ISTD tax number. */
  taxNumber: string;
  /** ISO 8601 issue timestamp of the invoice. */
  timestamp: string;
  /** Invoice total including VAT. */
  total: number;
  /** VAT amount on the invoice. */
  tax: number;
}

/** Base64 TLV payload to embed in the QR code (ISTD Jordan standard). */
export function buildJordanQrBase64(input: JordanQrInput): string {
  const payload = [
    ...tlvField(1, input.sellerName.trim()),
    ...tlvField(2, input.taxNumber.trim()),
    ...tlvField(3, input.timestamp),
    ...tlvField(4, jordanAmount(input.total)),
    ...tlvField(5, jordanAmount(input.tax)),
  ];
  let binary = "";
  for (const byte of payload) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Render the Base64 QR payload as a crisp-edge SVG string using the `qrcode`
 * module matrix directly (no async canvas round-trip), so the auto-print that
 * fires on checkout completes in the same frame.
 *
 * `qrcode` is loaded lazily: `buildJordanQrBase64` / `jordanAmount` (used by
 * the ISTD integration and the POS store) stay dependency-free, and the
 * ~90KB library is only pulled in when an actual receipt QR is rendered.
 */
export async function renderJordanQrSvg(content: string, scale = 4, quiet = 4): Promise<string> {
  const { default: QRCode } = await import("qrcode");
  const qr = QRCode.create(content, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const cell = Math.max(1, scale);
  const pad = quiet * cell;
  const dim = n * cell + pad * 2;
  const rects: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.data[r * n + c]) {
        rects.push(`<rect x="${pad + c * cell}" y="${pad + r * cell}" width="${cell}" height="${cell}"/>`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#fff"/>${rects.join("")}</svg>`
  );
}
