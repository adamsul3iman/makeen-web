import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";

interface MergeRequest {
  parentName?: string;
  baseCost?: number | null;
  basePrice?: number | null;
  productIds?: string[];
}

const MERGE_ERRORS: Record<string, string> = {
  parent_name_required: "اسم الصنف الأم مطلوب",
  parent_name_too_long: "اسم الصنف الأم طويل جداً",
  children_required: "اختر صنفين فرعيين على الأقل",
  too_many_children: "أقصى عدد أصناف للدمج هو 30",
  invalid_base_cost: "سعر التكلفة الأساسي غير صالح",
  invalid_base_price: "سعر البيع الأساسي غير صالح",
  child_not_found: "أحد الأصناف المختارة غير موجود في هذا المتجر",
  child_is_variant: "اختر أصنافاً قائمة بذاتها فقط — الأصناف المرتبطة بآب أو التي لها أصناف فرعية لا تُدمج",
  child_has_children: "لا يمكن دمج صنف لديه أصناف فرعية",
};

function cleanNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : Number.NaN;
}

export async function POST(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }

  const storeId = await authorizedCapabilityStoreId(request, "catalog.manage");
  if (storeId instanceof Response) return storeId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const input = (body ?? {}) as MergeRequest;
  const parentName = (input.parentName ?? "").trim();
  const productIds = Array.isArray(input.productIds)
    ? [...new Set(input.productIds.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  const baseCost = cleanNumber(input.baseCost);
  const basePrice = cleanNumber(input.basePrice);

  if (!parentName) {
    return Response.json({ error: "اسم الصنف الأم مطلوب" }, { status: 400 });
  }
  if (productIds.length < 2) {
    return Response.json({ error: "اختر صنفين فرعيين على الأقل" }, { status: 400 });
  }
  if (Number.isNaN(baseCost)) {
    return Response.json({ error: "سعر التكلفة الأساسي غير صالح" }, { status: 400 });
  }
  if (Number.isNaN(basePrice)) {
    return Response.json({ error: "سعر البيع الأساسي غير صالح" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("merge_into_variant_parent", {
    p_store_id: storeId,
    p_parent_name: parentName,
    p_base_cost: baseCost,
    p_base_price: basePrice,
    p_child_ids: productIds,
  });

  if (error) {
    const message = MERGE_ERRORS[error.message] ?? MERGE_ERRORS[error.code] ?? error.message;
    return Response.json({ error: message }, { status: 400 });
  }

  return Response.json({ parent: data });
}
