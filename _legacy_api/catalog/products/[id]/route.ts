import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";
import {
  CatalogProductError,
  deleteCatalogProduct,
  parseCatalogProductPayload,
  updateCatalogProduct,
} from "@/lib/catalogProducts";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }

  const storeId = await authorizedCapabilityStoreId(request, "catalog.manage");
  if (storeId instanceof Response) return storeId;

  const { id } = await params;
  if (!id) return Response.json({ error: "معرف المنتج مطلوب" }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const payload = parseCatalogProductPayload(body);
    const product = await updateCatalogProduct(supabase, storeId, id, payload);
    return Response.json({ product });
  } catch (err) {
    if (err instanceof CatalogProductError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("Update catalog product failed:", err);
    return Response.json({ error: "تعذر حفظ المنتج" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }

  const storeId = await authorizedCapabilityStoreId(request, "catalog.manage");
  if (storeId instanceof Response) return storeId;

  const { id } = await params;
  if (!id) return Response.json({ error: "معرف المنتج مطلوب" }, { status: 400 });

  try {
    await deleteCatalogProduct(supabase, storeId, id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof CatalogProductError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("Delete catalog product failed:", err);
    return Response.json({ error: "تعذر حذف المنتج" }, { status: 500 });
  }
}
