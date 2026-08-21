import { capabilityAuthorizationError, getAnyCapabilityAccess } from "@/lib/requestAuth";
import { RECEIVING_CAPABILITIES } from "@/lib/permissions";
import { supabase } from "@/lib/supabase";
import type { PriceHistoryResponse, PurchaseRecord } from "@/types/receiving.types";

export const dynamic = "force-dynamic";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Goods-in price lookup feeding the Negotiation Shield: the catalog's current
 * cost/retail for a barcode plus the last 3 purchase costs with their vendor
 * names (newest first). The mobile device caches the response so the shield
 * keeps rendering offline.
 */
export async function GET(request: Request): Promise<Response> {
  const access = await getAnyCapabilityAccess(request, [...RECEIVING_CAPABILITIES]);
  if (!access) return capabilityAuthorizationError(request, "suppliers.manage");

  const url = new URL(request.url);
  const barcode = (url.searchParams.get("barcode") ?? "").trim().slice(0, 120);
  if (!barcode) {
    return Response.json({ error: "باركود مطلوب" }, { status: 400 });
  }

  const empty: PriceHistoryResponse = {
    barcode,
    currentCost: 0,
    currentRetail: 0,
    description: barcode,
    history: [],
  };

  if (!supabase) return Response.json(empty);

  try {
    const variantResult = await supabase
      .from("product_variants")
      .select("product_id,variant_label")
      .eq("store_id", access.storeId)
      .eq("barcode", barcode)
      .maybeSingle();
    if (variantResult.error) throw variantResult.error;

    const productId = variantResult.data?.product_id ?? null;

    let currentCost = 0;
    let currentRetail = 0;
    let productName = barcode;
    if (productId) {
      const { data: productRow } = await supabase
        .from("products")
        .select("cost_price,selling_price,name")
        .eq("id", productId)
        .eq("store_id", access.storeId)
        .maybeSingle();
      currentCost = round2(Number(productRow?.cost_price) || 0);
      currentRetail = round2(Number(productRow?.selling_price) || 0);
      productName = productRow?.name ?? barcode;
    }

    // History is scoped to the resolved product when the barcode is known so
    // the shield never mixes another SKU's purchase costs into the card.
    let itemsQuery = supabase
      .from("supplier_invoice_items")
      .select(
        "unit_cost,quantity,supplier_invoices(invoice_number,invoice_date,suppliers(id,name))",
      )
      .eq("store_id", access.storeId);
    if (productId) itemsQuery = itemsQuery.eq("product_id", productId);
    const itemsResult = await itemsQuery
      .order("created_at", { ascending: false })
      .limit(10);
    if (itemsResult.error) throw itemsResult.error;

    const rows = (itemsResult.data ?? []) as Array<{
      unit_cost?: number;
      quantity?: number;
      supplier_invoices?: {
        invoice_number?: string;
        invoice_date?: string;
        suppliers?: { id?: string; name?: string } | null;
      } | null;
    }>;

    const history: PurchaseRecord[] = rows
      .filter((row) => productId === null || row.supplier_invoices)
      .slice(0, 3)
      .map((row) => ({
        cost: round2(Number(row.unit_cost) || 0),
        supplierId: row.supplier_invoices?.suppliers?.id ?? "",
        supplierName: row.supplier_invoices?.suppliers?.name ?? "مورد",
        invoiceNumber: row.supplier_invoices?.invoice_number ?? "",
        purchasedAt: row.supplier_invoices?.invoice_date ?? "",
        quantity: Number(row.quantity) || 0,
      }))
      .sort((a, b) => (b.purchasedAt ?? "").localeCompare(a.purchasedAt ?? ""));

    return Response.json({
      barcode,
      currentCost,
      currentRetail,
      description: productName,
      history,
    } satisfies PriceHistoryResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "receiving_price_history_failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
