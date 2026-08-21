import { supabase } from "@/lib/supabase";
import { authorizedStoreId } from "@/lib/requestAuth";
import { mockBarcodes, mockProducts } from "@/lib/mockCatalogData";
import { normalizeArabicText } from "@/lib/arabic";
import type { LocalBarcode } from "@/types/pos.types";

interface LabelVariant {
  barcode: string;
  unitName: string;
  multiplier: number;
  price: number;
}

interface LabelProduct {
  id: string;
  name: string;
  variants: LabelVariant[];
}

/** Minimal variant row from product_variants (no per-barcode prices). */
interface VariantRowLite {
  barcode: string;
  product_id: string;
  variant_label: string;
}

interface ProductPriceRow {
  id: string;
  selling_price: number;
  base_unit: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toVariants(
  rows: VariantRowLite[],
  priceMap: Map<string, ProductPriceRow>,
  limit: number,
): LabelVariant[] {
  return rows
    .map((v) => {
      const p = priceMap.get(v.product_id);
      return {
        barcode: v.barcode,
        unitName: v.variant_label || (p?.base_unit ?? ""),
        multiplier: 1,
        price: p?.selling_price ?? 0,
      };
    })
    .sort((a, b) => a.barcode.localeCompare(b.barcode))
    .slice(0, limit);
}

/**
 * Lean, searchable, paginated label picker. Returns only the fields the
 * barcode-labels screen needs (product id/name + barcode variants) instead of
 * the full catalog snapshot, and caps results so the admin page never renders
 * the entire catalog.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawQuery = (url.searchParams.get("q") ?? "").trim();
  const limit = clamp(Math.floor(Number(url.searchParams.get("limit") ?? "50")) || 50, 1, 200);
  const q = normalizeArabicText(rawQuery);

  const storeId = await authorizedStoreId(request);
  if (storeId instanceof Response) return storeId;

  let products: LabelProduct[];
  let total: number;

  if (supabase) {
    try {
      // Coarse Postgres substring filter, then exact Arabic-normalized matching in JS.
      const margin = Math.min(600, limit * 6);
      const productQuery = supabase
        .from("products")
        .select("id,name")
        .eq("store_id", storeId)
        .order("name", { ascending: true })
        .limit(margin);
      const variantQuery = supabase
        .from("product_variants")
        .select("barcode,product_id,variant_label")
        .eq("store_id", storeId)
        .eq("is_active", true)
        .order("barcode", { ascending: true })
        .limit(margin);
      const [nameRes, variantRes] = await Promise.all([
        q ? productQuery.ilike("name", `%${rawQuery}%`) : productQuery,
        q ? variantQuery.ilike("barcode", `%${rawQuery}%`) : variantQuery,
      ]);
      if (nameRes.error) throw nameRes.error;
      if (variantRes.error) throw variantRes.error;

      const productNames = new Map<string, string>();
      for (const row of (nameRes.data ?? []) as Array<{ id: string; name: string }>) {
        if (!q || normalizeArabicText(row.name).includes(q)) productNames.set(row.id, row.name);
      }

      const variantByCode = new Map<string, VariantRowLite>();
      const addVariants = (rows: VariantRowLite[] | null | undefined, matchQuery: boolean) => {
        for (const row of rows ?? []) {
          if (matchQuery && q && !normalizeArabicText(row.barcode).includes(q)) continue;
          variantByCode.set(row.barcode, row);
        }
      };
      addVariants(variantRes.data as VariantRowLite[] | null, true);

      // Name-matched products need their variants pulled explicitly.
      const nameMatchedIds = [...productNames.keys()];
      const matchedIds = new Set<string>([...nameMatchedIds, ...variantByCode.values().map((v) => v.product_id)]);
      const ids = [...matchedIds];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const { data, error } = await supabase
          .from("product_variants")
          .select("barcode,product_id,variant_label")
          .eq("store_id", storeId)
          .eq("is_active", true)
          .in("product_id", chunk);
        if (error) throw error;
        addVariants(data as VariantRowLite[] | null, false);
      }

      // Fetch prices from parent products.
      const allProductIds = [...new Set([...variantByCode.values()].map((v) => v.product_id))];
      const priceMap = new Map<string, ProductPriceRow>();
      for (let i = 0; i < allProductIds.length; i += 100) {
        const chunk = allProductIds.slice(i, i + 100);
        const { data, error } = await supabase
          .from("products")
          .select("id,selling_price,base_unit")
          .eq("store_id", storeId)
          .in("id", chunk);
        if (error) throw error;
        for (const row of (data ?? []) as ProductPriceRow[]) {
          priceMap.set(row.id, row);
        }
      }

      const variantsByProduct = new Map<string, VariantRowLite[]>();
      for (const row of variantByCode.values()) {
        const list = variantsByProduct.get(row.product_id) ?? [];
        list.push(row);
        variantsByProduct.set(row.product_id, list);
      }

      const all: LabelProduct[] = [...matchedIds]
        .map((id) => ({
          id,
          name: productNames.get(id) ?? "",
          variants: toVariants(variantsByProduct.get(id) ?? [], priceMap, limit),
        }))
        .filter((p) => p.variants.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name, "ar"));
      total = all.length;
      products = all.slice(0, limit);
    } catch (err) {
      console.error("Supabase label catalog fetch failed:", err);
      return Response.json({ error: "تعذر تحميل قائمة الملصقات" }, { status: 500 });
    }
  } else {
    const byProduct = new Map<string, LocalBarcode[]>();
    for (const b of mockBarcodes) {
      const list = byProduct.get(b.productId) ?? [];
      list.push(b);
      byProduct.set(b.productId, list);
    }
    const priceMap = new Map<string, ProductPriceRow>();
    for (const p of mockProducts) {
      priceMap.set(p.id, { id: p.id, selling_price: p.price, base_unit: p.baseUnit });
    }
    const all: LabelProduct[] = mockProducts
      .map((p) => ({
        id: p.id,
        name: p.name,
        variants: toVariants(
          (byProduct.get(p.id) ?? []).map((b) => ({
            barcode: b.barcode,
            product_id: b.productId,
            variant_label: b.variantLabel,
          })),
          priceMap,
          limit,
        ),
      }))
      .filter((p) => {
        if (p.variants.length === 0) return false;
        if (!q) return true;
        if (normalizeArabicText(p.name).includes(q)) return true;
        return p.variants.some((v) => normalizeArabicText(v.barcode).includes(q));
      })
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
    total = all.length;
    products = all.slice(0, limit);
  }

  return Response.json({ products, total });
}
