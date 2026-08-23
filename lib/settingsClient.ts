import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

export interface StoreSettings {
  id: string;
  code: string;
  name: string;
  ownerName: string;
  email: string;
  phone: string;
  logoUrl: string;
  address: string;
  receiptHeader: string;
  receiptFooter: string;
  loyaltyEnabled: boolean;
  pointsPerSpend: number;
  pointValue: number;
  taxPercent: number;
  taxNumber: string;
  receiptShowTaxNumber: boolean;
  receiptShowCashierTime: boolean;
  receiptShowBarcodeQr: boolean;
  receiptCompactSpacing: boolean;
  subscriptionStatus: string;
}

const SETTINGS_SELECT = "id,name,owner_name,email,phone,logo_url,address,receipt_header,receipt_footer,loyalty_enabled,points_per_spend,point_value,tax_percent,tax_number,receipt_show_tax_number,receipt_show_cashier_time,receipt_show_barcode_qr,receipt_compact_spacing,subscription_status,code";

function mapSettings(data: Record<string, unknown>): StoreSettings {
  return {
    id: data.id as string,
    code: (data.code as string) ?? "",
    name: data.name as string,
    ownerName: (data.owner_name as string) ?? "",
    email: (data.email as string) ?? "",
    phone: (data.phone as string) ?? "",
    logoUrl: (data.logo_url as string) ?? "",
    address: (data.address as string) ?? "",
    receiptHeader: (data.receipt_header as string) ?? "",
    receiptFooter: (data.receipt_footer as string) ?? "",
    loyaltyEnabled: data.loyalty_enabled !== false,
    pointsPerSpend: Number(data.points_per_spend) || 1,
    pointValue: Number(data.point_value) || 0.01,
    taxPercent: data.tax_percent != null ? Number(data.tax_percent) : 16,
    taxNumber: (data.tax_number as string) ?? "",
    receiptShowTaxNumber: data.receipt_show_tax_number !== false,
    receiptShowCashierTime: data.receipt_show_cashier_time !== false,
    receiptShowBarcodeQr: data.receipt_show_barcode_qr !== false,
    receiptCompactSpacing: data.receipt_compact_spacing === true,
    subscriptionStatus: (data.subscription_status as string) ?? "active",
  };
}

export async function fetchSettings(): Promise<StoreSettings> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  const { data, error } = await sb
    .from("stores")
    .select(SETTINGS_SELECT)
    .eq("id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("المتجر غير موجود");
  return mapSettings(data);
}

export async function updateSettings(fields: Partial<StoreSettings>): Promise<StoreSettings> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  if (!fields.name?.trim()) throw new Error("اسم المتجر مطلوب");

  const updateData: Record<string, unknown> = {};
  if (fields.name !== undefined) updateData.name = fields.name.trim();
  if (fields.ownerName !== undefined) updateData.owner_name = fields.ownerName;
  if (fields.email !== undefined) updateData.email = fields.email.trim().toLowerCase();
  if (fields.phone !== undefined) updateData.phone = fields.phone;
  if (fields.logoUrl !== undefined) updateData.logo_url = fields.logoUrl;
  if (fields.address !== undefined) updateData.address = fields.address;
  if (fields.receiptHeader !== undefined) updateData.receipt_header = fields.receiptHeader;
  if (fields.receiptFooter !== undefined) updateData.receipt_footer = fields.receiptFooter;
  if (fields.loyaltyEnabled !== undefined) updateData.loyalty_enabled = fields.loyaltyEnabled;
  if (fields.pointsPerSpend !== undefined) updateData.points_per_spend = fields.pointsPerSpend;
  if (fields.pointValue !== undefined) updateData.point_value = fields.pointValue;
  if (fields.taxPercent !== undefined) updateData.tax_percent = fields.taxPercent;
  if (fields.taxNumber !== undefined) updateData.tax_number = fields.taxNumber;
  if (fields.receiptShowTaxNumber !== undefined) updateData.receipt_show_tax_number = fields.receiptShowTaxNumber;
  if (fields.receiptShowCashierTime !== undefined) updateData.receipt_show_cashier_time = fields.receiptShowCashierTime;
  if (fields.receiptShowBarcodeQr !== undefined) updateData.receipt_show_barcode_qr = fields.receiptShowBarcodeQr;
  if (fields.receiptCompactSpacing !== undefined) updateData.receipt_compact_spacing = fields.receiptCompactSpacing;

  const { data, error } = await sb
    .from("stores")
    .update(updateData)
    .eq("id", storeId)
    .select(SETTINGS_SELECT)
    .single();
  if (error || !data) throw new Error(error?.message ?? "المتجر غير موجود");

  if (fields.email) {
    await sb
      .from("cashiers")
      .update({ email: fields.email.trim().toLowerCase() })
      .eq("store_id", storeId)
      .eq("role", "admin")
      .neq("email", fields.email.trim().toLowerCase());
  }

  return mapSettings(data);
}

export interface TaxSettings {
  taxNumber: string;
  istdClientId: string;
  istdSecretMasked: string;
  configured: boolean;
}

export async function fetchTaxSettings(): Promise<TaxSettings> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  const { data, error } = await sb
    .from("tenant_tax_settings")
    .select("tax_number,istd_client_id,istd_client_secret")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const taxNumber = data?.tax_number ?? "";
  const istdClientId = data?.istd_client_id ?? "";
  const hasSecret = Boolean(data?.istd_client_secret);
  return {
    taxNumber,
    istdClientId,
    istdSecretMasked: hasSecret ? "***configured***" : "",
    configured: taxNumber.trim().length > 0 && istdClientId.trim().length > 0 && hasSecret,
  };
}

export async function updateTaxSettings(data: {
  tax_number?: string;
  istd_client_id?: string;
  istd_client_secret?: string;
}): Promise<TaxSettings> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const taxNumber = (data.tax_number ?? "").trim().slice(0, 30);
  const istdClientId = (data.istd_client_id ?? "").trim().slice(0, 200);
  let istdClientSecret = (data.istd_client_secret ?? "").trim();

  if (!istdClientSecret) {
    const { data: existing } = await sb
      .from("tenant_tax_settings")
      .select("istd_client_secret")
      .eq("store_id", storeId)
      .maybeSingle();
    istdClientSecret = existing?.istd_client_secret ?? "";
  }

  const { error: upsertError } = await sb
    .from("tenant_tax_settings")
    .upsert(
      { store_id: storeId, tax_number: taxNumber, istd_client_id: istdClientId, istd_client_secret: istdClientSecret },
      { onConflict: "store_id" },
    );
  if (upsertError) throw new Error(upsertError.message);

  if (taxNumber) {
    await sb.from("stores").update({ tax_number: taxNumber }).eq("id", storeId);
  }

  const hasSecret = Boolean(istdClientSecret);
  return {
    taxNumber,
    istdClientId,
    istdSecretMasked: hasSecret ? "***configured***" : "",
    configured: Boolean(taxNumber && istdClientId && hasSecret),
  };
}

export async function updateLogo(dataUrl: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  const { error } = await sb
    .from("stores")
    .update({ logo_url: dataUrl })
    .eq("id", storeId);
  if (error) throw new Error(error.message);
  await sb.from("admin_audit_logs").insert({
    store_id: storeId,
    admin_id: "owner",
    admin_name: "المدير",
    action_type: "UPDATE_RECEIPT_LOGO",
    target_id: null,
    details: {},
  });
}

export async function changeAdminAccount(data: {
  current_password: string;
  new_email?: string;
  new_password?: string;
}): Promise<{ ok: boolean; email?: string }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  const { data: result, error } = await sb.rpc("update_admin_credentials", {
    p_current_email: data.current_password ? (data.new_email ?? "") : "",
    p_current_password: data.current_password,
    p_new_email: data.new_email ?? "",
    p_new_password: data.new_password ?? "",
    p_token: "",
  });
  if (error) throw new Error(error.message);
  if (!result || typeof result !== "object") throw new Error("كلمة المرور الحالية غير صحيحة");
  return { ok: true, email: (result as { email?: string }).email ?? data.new_email };
}
