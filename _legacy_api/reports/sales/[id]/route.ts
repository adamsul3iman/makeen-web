import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import {
  buildTaxBreakdown,
  invoiceReference,
  ledgerNumber,
  ledgerText,
  mapSalesInvoiceItem,
  mapSalesLedgerInvoice,
} from "@/lib/salesLedger";
import { supabase } from "@/lib/supabase";
import type { SalesInvoiceDetail, SalesInvoicePaymentDetail } from "@/types/salesLedger.types";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const access = await getCapabilityAccess(request, "reports.view");
  if (!access) return capabilityAuthorizationError(request, "reports.view");
  const { id } = await params;

  const invoiceResult = await supabase
    .from("sales_invoices")
    .select("id,sync_id,branch_id,terminal_id,shift_id,cashier_id,cashier_name,customer_id,customer_name,customer_phone,payment_method,subtotal,tax,discount,delivery_fee,total,amount_paid,change_amount,cash_amount,visa_amount,cliq_amount,debt_amount,item_count,gross_profit,is_return,is_cancellation,original_invoice_sync_id,completed_at,istd_uuid,istd_qr")
    .eq("id", id)
    .eq("store_id", access.storeId)
    .maybeSingle();
  if (invoiceResult.error) return Response.json({ error: invoiceResult.error.message }, { status: 500 });
  if (!invoiceResult.data) return Response.json({ error: "الفاتورة غير موجودة" }, { status: 404 });

  const invoiceRow = invoiceResult.data as Record<string, unknown>;
  const branchId = ledgerText(invoiceRow.branch_id);
  const terminalId = ledgerText(invoiceRow.terminal_id);
  const syncId = ledgerText(invoiceRow.sync_id);
  const [itemResult, paymentResult, branchResult, terminalResult, returnResult] = await Promise.all([
    supabase
      .from("sales_invoice_items")
      .select("id,line_no,product_id,product_name,barcode,variant_label,unit_name,qty,multiplier,unit_price,line_subtotal,line_discount,net_total,tax_percent,tax_included,tax_amount,line_total,cost_price,cost_total,gross_profit")
      .eq("invoice_id", id)
      .eq("store_id", access.storeId)
      .order("line_no"),
    supabase.from("sales_payments").select("method,amount").eq("invoice_id", id).eq("store_id", access.storeId),
    branchId ? supabase.from("branches").select("name").eq("id", branchId).eq("store_id", access.storeId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    terminalId ? supabase.from("terminals").select("name").eq("id", terminalId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabase
      .from("sales_invoices")
      .select("id,sync_id,total,completed_at")
      .eq("store_id", access.storeId)
      .eq("original_invoice_sync_id", syncId)
      .order("completed_at", { ascending: false }),
  ]);
  if (itemResult.error) return Response.json({ error: itemResult.error.message }, { status: 500 });
  if (paymentResult.error) return Response.json({ error: paymentResult.error.message }, { status: 500 });
  if (branchResult.error) return Response.json({ error: branchResult.error.message }, { status: 500 });
  if (terminalResult.error) return Response.json({ error: terminalResult.error.message }, { status: 500 });
  if (returnResult.error) return Response.json({ error: returnResult.error.message }, { status: 500 });

  invoiceRow.branch_name = branchResult.data?.name ?? "";
  invoiceRow.terminal_name = terminalResult.data?.name ?? "";
  const items = (itemResult.data ?? []).map((row) => mapSalesInvoiceItem(row as Record<string, unknown>));
  invoiceRow.profit_reliable = items.every((item) => item.profitReliable);
  const base = mapSalesLedgerInvoice(invoiceRow);
  const detail: SalesInvoiceDetail = {
    ...base,
    amountPaid: ledgerNumber(invoiceRow.amount_paid),
    changeAmount: ledgerNumber(invoiceRow.change_amount),
    items,
    payments: (paymentResult.data ?? []).map((row) => ({
      method: (["CASH", "VISA", "DEBT", "CLIQ"].includes(row.method) ? row.method : "UNKNOWN") as SalesInvoicePaymentDetail["method"],
      amount: ledgerNumber(row.amount),
    })),
    taxBreakdown: buildTaxBreakdown(items),
    linkedReturns: (returnResult.data ?? []).map((row) => ({
      id: row.id,
      syncId: row.sync_id,
      reference: invoiceReference(row.sync_id),
      total: ledgerNumber(row.total),
      completedAt: row.completed_at,
    })),
  };
  return Response.json({ invoice: detail });
}
