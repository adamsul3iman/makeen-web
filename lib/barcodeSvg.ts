/**
 * CODE128 barcode → SVG string, rendered on the client.
 *
 * The receipt print document is a self-contained HTML string (no Tailwind, no
 * host DOM), so the barcode cannot be a live React <svg> that JsBarcode mutates
 * after mount. Instead we render JsBarcode into a detached SVG node and read
 * its serialized markup, then inline that string into the print document —
 * exactly like the fiscal QR SVG.
 *
 * Returns `null` on failure (bad input, missing DOM, JsBarcode error) so the
 * caller can degrade gracefully; the print job must never be blocked by it.
 */

export async function renderBarcodeSvg(
  value: string,
  opts: { height?: number; width?: number } = {},
): Promise<string | null> {
  if (typeof document === "undefined" || !value) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  try {
    const { default: JsBarcode } = await import("jsbarcode");
    JsBarcode(svg, value, {
      format: "CODE128",
      width: opts.width ?? 1.6, // ~203dpi bare module width
      height: opts.height ?? 36,
      displayValue: false,
      margin: 0,
      background: "#ffffff",
      lineColor: "#000000",
    });
  } catch {
    return null;
  }
  const markup = svg.outerHTML;
  if (!markup || markup.length < 20) return null;
  return markup;
}
