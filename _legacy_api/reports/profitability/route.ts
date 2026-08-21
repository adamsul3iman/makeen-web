import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import {
  attachInputTax,
  emptyProfitabilitySnapshot,
  mapProfitabilitySnapshot,
  profitabilityDelta,
} from "@/lib/profitability";
import { mapSupplierSummary } from "@/lib/supplierAccounts";
import { opsToken } from "@/lib/platformOps";
import { supabase } from "@/lib/supabase";
import type { ProfitabilityPeriod, ProfitabilityResponse } from "@/types/profitability.types";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "profitability_report_failed";
}

function parseDate(value: string | null, fallback: Date, endOfDay = false): Date {
  if (!value) return fallback;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`)
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function period(from: Date, to: Date): ProfitabilityPeriod {
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    days: Math.max(1, Math.ceil((to.getTime() - from.getTime() + 1) / DAY_MS)),
  };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const now = new Date();
  const to = parseDate(url.searchParams.get("to"), now, true);
  const from = parseDate(url.searchParams.get("from"), new Date(to.getTime() - 29 * DAY_MS));
  if (from > to) {
    return Response.json({ error: "تاريخ البداية يجب أن يسبق تاريخ النهاية" }, { status: 400 });
  }
  if (to.getTime() - from.getTime() > 731 * DAY_MS) {
    return Response.json({ error: "الفترة القصوى لقائمة الدخل سنتان" }, { status: 400 });
  }

  const currentPeriod = period(from, to);
  const previousTo = new Date(from.getTime() - 1);
  const previousFrom = new Date(previousTo.getTime() - (to.getTime() - from.getTime()));
  const previousPeriod = period(previousFrom, previousTo);

  if (!supabase) {
    const current = emptyProfitabilitySnapshot(currentPeriod);
    const previous = emptyProfitabilitySnapshot(previousPeriod);
    return Response.json({
      current,
      previous,
      deltaPercent: profitabilityDelta(current, previous),
      generatedAt: new Date().toISOString(),
    } satisfies ProfitabilityResponse);
  }

  const access = await getCapabilityAccess(request, "reports.profitability");
  if (!access) return capabilityAuthorizationError(request, "reports.profitability");

  try {
    const [currentResult, previousResult, currentSupplierResult, previousSupplierResult] = await Promise.all([
      supabase.rpc("profitability_statement", {
        p_store_id: access.storeId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      }),
      supabase.rpc("profitability_statement", {
        p_store_id: access.storeId,
        p_from: previousFrom.toISOString(),
        p_to: previousTo.toISOString(),
      }),
      supabase.rpc("secure_supplier_accounting_summary", {
        p_store_id: access.storeId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_token: opsToken(),
      }),
      supabase.rpc("secure_supplier_accounting_summary", {
        p_store_id: access.storeId,
        p_from: previousFrom.toISOString(),
        p_to: previousTo.toISOString(),
        p_token: opsToken(),
      }),
    ]);
    if (currentResult.error) throw currentResult.error;
    if (previousResult.error) throw previousResult.error;
    if (currentSupplierResult.error) throw currentSupplierResult.error;
    if (previousSupplierResult.error) throw previousSupplierResult.error;
    const current = attachInputTax(
      mapProfitabilitySnapshot(currentResult.data, currentPeriod),
      mapSupplierSummary(currentSupplierResult.data).inputTax,
    );
    const previous = attachInputTax(
      mapProfitabilitySnapshot(previousResult.data, previousPeriod),
      mapSupplierSummary(previousSupplierResult.data).inputTax,
    );
    return Response.json({
      current,
      previous,
      deltaPercent: profitabilityDelta(current, previous),
      generatedAt: new Date().toISOString(),
    } satisfies ProfitabilityResponse);
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}
