import { supabase } from "@/lib/supabase";
import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import { normalizePrintTemplateConfig } from "@/lib/printTemplates";
import type { PrintTemplate, PrintTemplateKind } from "@/types/printTemplates";

interface PrintTemplateRow {
  id: string;
  kind: PrintTemplateKind;
  name: string;
  is_default: boolean;
  config: unknown;
  created_at: string;
  updated_at: string;
}

async function auditTemplateChange(
  access: { storeId: string; actorId: string; actorName: string },
  actionType: "SAVE_PRINT_TEMPLATE" | "DELETE_PRINT_TEMPLATE",
  targetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  if (!supabase) return;
  await supabase.from("admin_audit_logs").insert({
    store_id: access.storeId,
    admin_id: null,
    admin_name: access.actorName,
    action_type: actionType,
    target_id: targetId,
    details: { ...details, actor: access.actorId },
  });
}

function mapRow(row: PrintTemplateRow): PrintTemplate {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    isDefault: row.is_default,
    config: normalizePrintTemplateConfig(row.kind, row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireAdmin(request: Request) {
  return (await getCapabilityAccess(request, "print_studio.manage")) ??
    await capabilityAuthorizationError(request, "print_studio.manage");
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await requireAdmin(request);
  if (access instanceof Response) return access;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json" }, { status: 400 });
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return Response.json({ error: "اسم القالب مطلوب" }, { status: 400 });

  if (!supabase) {
    const kind: PrintTemplateKind = body.kind === "BARCODE_LABEL" ? "BARCODE_LABEL" : "RECEIPT";
    const now = new Date().toISOString();
    return Response.json({ template: { id, kind, name, isDefault: body.isDefault === true, config: normalizePrintTemplateConfig(kind, body.config), createdAt: now, updatedAt: now } });
  }

  const found = await supabase
    .from("print_templates")
    .select("id,kind,is_default")
    .eq("id", id)
    .eq("store_id", access.storeId)
    .maybeSingle();
  if (found.error) return Response.json({ error: found.error.message }, { status: 500 });
  if (!found.data) return Response.json({ error: "القالب غير موجود" }, { status: 404 });
  const kind = found.data.kind as PrintTemplateKind;
  const isDefault = body.isDefault === true;
  if (found.data.is_default && !isDefault) {
    return Response.json({ error: "عيّن قالباً افتراضياً آخر بدلاً منه" }, { status: 409 });
  }
  const { data, error } = await supabase.rpc("save_print_template", {
    p_store_id: access.storeId,
    p_id: id,
    p_kind: kind,
    p_name: name,
    p_is_default: isDefault,
    p_config: normalizePrintTemplateConfig(kind, body.config),
  });
  if (error || !data) return Response.json({ error: error?.message ?? "تعذر حفظ القالب" }, { status: 500 });
  const template = mapRow(data as PrintTemplateRow);
  await auditTemplateChange(access, "SAVE_PRINT_TEMPLATE", id, { kind, name: template.name, isDefault, operation: "UPDATE" });
  return Response.json({ template });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await requireAdmin(request);
  if (access instanceof Response) return access;
  const { id } = await params;
  if (!supabase) return Response.json({ ok: true });

  const found = await supabase
    .from("print_templates")
    .select("id,is_default")
    .eq("id", id)
    .eq("store_id", access.storeId)
    .maybeSingle();
  if (found.error) return Response.json({ error: found.error.message }, { status: 500 });
  if (!found.data) return Response.json({ error: "القالب غير موجود" }, { status: 404 });
  if (found.data.is_default) {
    return Response.json({ error: "عيّن قالباً افتراضياً آخر قبل الحذف" }, { status: 409 });
  }
  const removed = await supabase.from("print_templates").delete().eq("id", id).eq("store_id", access.storeId);
  if (removed.error) return Response.json({ error: removed.error.message }, { status: 500 });
  await auditTemplateChange(access, "DELETE_PRINT_TEMPLATE", id, { operation: "DELETE" });
  return Response.json({ ok: true });
}
