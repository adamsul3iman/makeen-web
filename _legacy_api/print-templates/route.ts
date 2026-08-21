import { randomUUID } from "node:crypto";
import { supabase } from "@/lib/supabase";
import { capabilityAuthorizationError, getCapabilityAccess, getStoreAccess } from "@/lib/requestAuth";
import {
  DEFAULT_BARCODE_LABEL_TEMPLATE,
  DEFAULT_RECEIPT_TEMPLATE,
  normalizePrintTemplateConfig,
} from "@/lib/printTemplates";
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
  targetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  if (!supabase) return;
  await supabase.from("admin_audit_logs").insert({
    store_id: access.storeId,
    admin_id: null,
    admin_name: access.actorName,
    action_type: "SAVE_PRINT_TEMPLATE",
    target_id: targetId,
    details: { ...details, actor: access.actorId },
  });
}

function validKind(value: unknown): value is PrintTemplateKind {
  return value === "RECEIPT" || value === "BARCODE_LABEL";
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

function mockTemplates(kind?: PrintTemplateKind): PrintTemplate[] {
  const now = new Date().toISOString();
  const rows: PrintTemplate[] = [
    {
      id: "mock-receipt-template",
      kind: "RECEIPT",
      name: "الفاتورة الحرارية الأساسية",
      isDefault: true,
      config: DEFAULT_RECEIPT_TEMPLATE,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "mock-label-template",
      kind: "BARCODE_LABEL",
      name: "ملصق 40 × 25",
      isDefault: true,
      config: DEFAULT_BARCODE_LABEL_TEMPLATE,
      createdAt: now,
      updatedAt: now,
    },
  ];
  return kind ? rows.filter((row) => row.kind === kind) : rows;
}

async function requireStore(request: Request) {
  const access = await getStoreAccess(request);
  return access ?? Response.json({ error: "store_session_required" }, { status: 401 });
}

export async function GET(request: Request): Promise<Response> {
  const access = await requireStore(request);
  if (access instanceof Response) return access;
  const url = new URL(request.url);
  const rawKind = url.searchParams.get("kind");
  if (rawKind && !validKind(rawKind)) {
    return Response.json({ error: "نوع القالب غير صالح" }, { status: 400 });
  }
  const kind: PrintTemplateKind | undefined = rawKind && validKind(rawKind) ? rawKind : undefined;

  if (!supabase) return Response.json({ templates: mockTemplates(kind) });

  let query = supabase
    .from("print_templates")
    .select("id,kind,name,is_default,config,created_at,updated_at")
    .eq("store_id", access.storeId)
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false });
  if (kind) query = query.eq("kind", kind);
  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ templates: (data ?? []).map((row) => mapRow(row as PrintTemplateRow)) });
}

export async function POST(request: Request): Promise<Response> {
  const access = await getCapabilityAccess(request, "print_studio.manage");
  if (!access) return capabilityAuthorizationError(request, "print_studio.manage");

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !validKind(body.kind)) {
    return Response.json({ error: "نوع القالب غير صالح" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return Response.json({ error: "اسم القالب مطلوب" }, { status: 400 });
  const config = normalizePrintTemplateConfig(body.kind, body.config);
  const isDefault = body.isDefault === true;

  if (!supabase) {
    const now = new Date().toISOString();
    return Response.json({
      template: {
        id: randomUUID(),
        kind: body.kind,
        name,
        isDefault,
        config,
        createdAt: now,
        updatedAt: now,
      },
    }, { status: 201 });
  }

  const { data, error } = await supabase.rpc("save_print_template", {
    p_store_id: access.storeId,
    p_id: null,
    p_kind: body.kind,
    p_name: name,
    p_is_default: isDefault,
    p_config: config,
  });
  if (error || !data) return Response.json({ error: error?.message ?? "تعذر إنشاء القالب" }, { status: 500 });
  const template = mapRow(data as PrintTemplateRow);
  await auditTemplateChange(access, template.id, { kind: template.kind, name: template.name, isDefault, operation: "CREATE" });
  return Response.json({ template }, { status: 201 });
}
