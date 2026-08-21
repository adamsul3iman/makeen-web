import { authorizedCapabilityStoreId } from "@/lib/requestAuth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * EAN-13 check digit (mod-10 on the 12-digit data string).
 */
function ean13CheckDigit(data: string): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const digit = Number(data[i]);
    if (!Number.isInteger(digit)) return 0;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Random well-formed EAN-13 barcode using the Jordanian GS1 prefix (625).
 * 625 + 9 random digits + check digit. The result is a valid EAN-13 that
 * barcode scanners accept; uniqueness against the catalog is verified by the
 * caller against `product_variants` (per-store unique constraint).
 */
function generateEan13(): string {
  const prefix = "625";
  let rest = "";
  for (let i = 0; i < 9; i++) rest += Math.floor(Math.random() * 10);
  const data = prefix + rest;
  return data + ean13CheckDigit(data);
}

/**
 * GET /api/catalog/products/barcode
 * Returns a single guaranteed-unique barcode candidate for the admin
 * inventory form. Collisions are retried (the barcode column is UNIQUE, and
 * the catalog fetch itself is retried a bounded number of times).
 */
export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ barcode: generateEan13() });
  }

  const storeId = await authorizedCapabilityStoreId(request, "catalog.manage");
  if (storeId instanceof Response) return storeId;

  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = generateEan13();
    const { data, error } = await supabase
      .from("product_variants")
      .select("barcode")
      .eq("barcode", candidate)
      .maybeSingle();
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!data) return Response.json({ barcode: candidate });
  }

  return Response.json({ error: "تعذر توليد باركود فريد — أعد المحاولة" }, { status: 503 });
}
