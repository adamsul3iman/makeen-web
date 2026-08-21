import { supabase } from "@/lib/supabase";
import { getCapabilityAccess } from "@/lib/requestAuth";

export const dynamic = "force-dynamic";

interface VariantRow {
  variant_label: string;
  barcode: string;
  total_stock: number;
}

/**
 * Lightweight product search for admin dropdowns.
 * Returns at most `limit` (default 15, max 50) products whose name matches
 * `?q=...` via case-insensitive LIKE.  Each result includes the product's
 * aggregate stock and barcode variants so the inventory-adjustment form
 * works without loading the full catalog.
 */
export async function GET(request: Request): Promise<Response> {
  const access = await getCapabilityAccess(request, "inventory.view");
  if (!access) {
    return Response.json({ error: "غير مصرح" }, { status: 403 });
  }
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }

  const url = new URL(request.url);
  const rawQuery = url.searchParams.get("q") ?? "";
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 15));

  let productQuery = supabase
    .from("products")
    .select("id,name,base_unit,total_stock")
    .eq("store_id", access.storeId)
    .eq("is_active", true)
    .order("name", { ascending: true })
    .limit(limit);

  if (rawQuery.trim()) {
    const q = rawQuery.trim();
    productQuery = productQuery.or(`name.ilike.%${q}%,id.eq.${q}`);
  }

  const { data: products, error: productError } = await productQuery;
  if (productError) {
    return Response.json({ error: productError.message }, { status: 500 });
  }
  if (!products || products.length === 0) {
    return Response.json({ products: [] });
  }

  const productIds = products.map((p) => p.id);

  const { data: variants } = await supabase
    .from("product_variants")
    .select("product_id,variant_label,barcode,total_stock")
    .in("product_id", productIds)
    .eq("is_active", true)
    .order("barcode", { ascending: true });

  const variantsByProduct = new Map<string, VariantRow[]>();
  for (const v of variants ?? []) {
    const list = variantsByProduct.get(v.product_id);
    if (list) list.push(v);
    else variantsByProduct.set(v.product_id, [v]);
  }

  return Response.json({
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      baseUnit: p.base_unit,
      stock: Number(p.total_stock ?? 0),
      barcodes: (variantsByProduct.get(p.id) ?? []).map((v) => ({
        barcode: v.barcode,
        variantLabel: v.variant_label ?? "",
        unitName: p.base_unit,
        multiplier: 1,
      })),
    })),
  });
}
