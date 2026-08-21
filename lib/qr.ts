/**
 * Fiscal Smart QR (Phase 25).
 *
 * Builds the legally-compliant Base64 TLV payload used on thermal receipts:
 *   tag 1 = Seller Name
 *   tag 2 = Tax / fiscal identification number
 *   tag 3 = Timestamp (ISO 8601)
 *   tag 4 = Total amount (incl. VAT, 2 decimals)
 *   tag 5 = Tax amount (2 decimals)
 *
 * Tags are single bytes; lengths follow DER/BER style (short-form under 128,
 * long-form beyond), so Arabic UTF-8 seller names are safe. The final QR
 * content is the Base64 of the raw TLV byte sequence — exactly what fiscal
 * scanners expect from the printed receipt.
 */

/** Effective VAT percent for a store: its own setting, else legacy 16%. */
export function effectiveTaxPercent(store?: { taxPercent?: number } | null): number {
  const t = store?.taxPercent;
  if (typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= 100) return t;
  return 16;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Amount string used in the TLV: fixed 2 decimals, no negative zero. */
export function fiscalAmount(n: number): string {
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

export interface FiscalQrInput {
  sellerName: string;
  taxNumber: string;
  /** ISO 8601 timestamp of the sale. */
  timestamp: string;
  /** Invoice total including VAT. */
  total: number;
  /** VAT amount on the invoice. */
  tax: number;
}

/** Base64 TLV payload to embed in the QR code. */
export function buildFiscalQrBase64(input: FiscalQrInput): string {
  const payload = [
    ...tlvField(1, input.sellerName.trim()),
    ...tlvField(2, input.taxNumber.trim()),
    ...tlvField(3, input.timestamp),
    ...tlvField(4, fiscalAmount(input.total)),
    ...tlvField(5, fiscalAmount(input.tax)),
  ];
  let binary = "";
  for (const byte of payload) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Render the QR content as a crisp-edge SVG string.
 * Uses the `qrcode` module matrix directly (no async canvas round-trip),
 * so the auto-print triggered on checkout completes in the same frame.
 *
 * `qrcode` is loaded lazily so importing this module (or the pure TLV
 * helpers above, used by the POS store on every scan) never drags the
 * ~90KB library into the eager client bundle.
 */
export async function renderFiscalQrSvg(content: string, scale = 4, quiet = 4): Promise<string> {
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
