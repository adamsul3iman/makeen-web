import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface ProductRow {
  product_id: string | null;
  product_name: string;
  barcode: string;
  unit_name: string;
  qty: number;
  unit_price: number;
  line_subtotal: number;
  line_discount: number;
  line_total: number;
  cost_price: number;
  cost_total: number;
  gross_profit: number;
  is_return: boolean;
}

interface ProductSummary {
  productId: string | null;
  productName: string;
  barcode: string;
  unitName: string;
  totalQty: number;
  totalRevenue: number;
  totalCost: number;
  totalProfit: number;
  totalDiscount: number;
  invoiceCount: number;
}

interface TaxSummary {
  taxPercent: number;
  netAmount: number;
  taxAmount: number;
  totalWithTax: number;
  lineCount: number;
}

/**
 * GET /api/shifts/[id]/items?tab=products|taxes&storeId=...
 * Aggregated product or tax data for a single shift, loaded on-demand for the
 * EndShiftModal analytics tabs.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const storeId = await authorizedCapabilityStoreId(request, "shifts.view");
  if (storeId instanceof Response) return storeId;

  const { id: shiftIdParam } = await context.params;
  const shiftId = text(shiftIdParam);
  if (!shiftId || !UUID_RE.test(shiftId)) {
    return Response.json({ error: "invalid_shift_id" }, { status: 400 });
  }

  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") ?? "products";

  if (!supabase) {
    return Response.json({ items: [], summary: null });
  }

  const { data: invoices, error: invError } = await supabase
    .from("sales_invoices")
    .select("id, is_return")
    .eq("store_id", storeId)
    .eq("shift_id", shiftId);

  if (invError) {
    return Response.json({ error: invError.message }, { status: 500 });
  }
  if (!invoices || invoices.length === 0) {
    return Response.json({ items: [], summary: null });
  }

  const invoiceIds = invoices.map((inv) => inv.id);
  const returnInvoiceIds = new Set(invoices.filter((inv) => inv.is_return).map((inv) => inv.id));

  const { data: items, error: itemsError } = await supabase
    .from("sales_invoice_items")
    .select("product_id,product_name,barcode,unit_name,qty,line_subtotal,line_discount,line_total,cost_price,cost_total,gross_profit,invoice_id")
    .eq("store_id", storeId)
    .in("invoice_id", invoiceIds);

  if (itemsError) {
    return Response.json({ error: itemsError.message }, { status: 500 });
  }

  const rows = (items ?? []) as Array<ProductRow & { invoice_id: string }>;

  if (tab === "products") {
    const byProduct = new Map<string, ProductSummary>();
    for (const row of rows) {
      const key = row.product_id ?? `__none:${row.product_name}`;
      const existing = byProduct.get(key) ?? {
        productId: row.product_id,
        productName: row.product_name,
        barcode: row.barcode,
        unitName: row.unit_name,
        totalQty: 0,
        totalRevenue: 0,
        totalCost: 0,
        totalProfit: 0,
        totalDiscount: 0,
        invoiceCount: 0,
      };
      const isReturn = returnInvoiceIds.has(row.invoice_id);
      const sign = isReturn ? -1 : 1;
      existing.totalQty += sign * Number(row.qty) || 0;
      existing.totalRevenue += sign * Number(row.line_total) || 0;
      existing.totalCost += sign * Number(row.cost_total) || 0;
      existing.totalProfit += sign * Number(row.gross_profit) || 0;
      existing.totalDiscount += sign * Number(row.line_discount) || 0;
      byProduct.set(key, existing);
    }
    const productSummary = Array.from(byProduct.values())
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
    const top20 = productSummary.slice(0, 20);
    return Response.json({ items: top20, totalProducts: productSummary.length });
  }

  if (tab === "taxes") {
    const byTax = new Map<number, TaxSummary>();
    for (const row of rows) {
      const lineSubtotal = Number(row.line_subtotal) || 0;
      const lineTotal = Number(row.line_total) || 0;
      const taxAmount = Math.max(0, lineTotal - lineSubtotal);
      const taxPercent = lineSubtotal > 0 ? Math.round((taxAmount / lineSubtotal) * 100 * 100) / 100 : 0;
      const rounded = Math.round(taxPercent * 10) / 10;
      const existing = byTax.get(rounded) ?? {
        taxPercent: rounded,
        netAmount: 0,
        taxAmount: 0,
        totalWithTax: 0,
        lineCount: 0,
      };
      const isReturn = returnInvoiceIds.has(row.invoice_id);
      const sign = isReturn ? -1 : 1;
      existing.netAmount += sign * lineSubtotal;
      existing.taxAmount += sign * taxAmount;
      existing.totalWithTax += sign * lineTotal;
      existing.lineCount += 1;
      byTax.set(rounded, existing);
    }
    const taxSummary = Array.from(byTax.values()).sort((a, b) => b.taxAmount - a.taxAmount);
    return Response.json({ items: taxSummary });
  }

  return Response.json({ error: "invalid_tab" }, { status: 400 });
}
