import { supabase } from "@/lib/supabase";
import { authorizedAnyCapabilityStoreId } from "@/lib/requestAuth";
import {
  CatalogProductError,
  createCatalogProduct,
  parseCatalogProductPayload,
} from "@/lib/catalogProducts";

export async function POST(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }

  const storeId = await authorizedAnyCapabilityStoreId(request, ["catalog.manage", "catalog.add"]);
  if (storeId instanceof Response) return storeId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const payload = parseCatalogProductPayload(body);
    const product = await createCatalogProduct(supabase, storeId, payload);
    return Response.json({ product }, { status: 201 });
  } catch (err) {
    if (err instanceof CatalogProductError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("Create catalog product failed:", err);
    return Response.json({ error: "تعذر حفظ المنتج" }, { status: 500 });
  }
}
