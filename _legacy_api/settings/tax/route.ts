import { getAdminSession } from "@/lib/adminSession";
import { supabase } from "@/lib/supabase";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const ENC_KEY = process.env.ENCRYPTION_KEY ?? "0000000000000000000000000000000000000000000000000000000000000000";

function encryptSecret(plaintext: string): string {
  const key = Buffer.from(ENC_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

function decryptSecret(encryptedValue: string): string {
  if (!encryptedValue.startsWith("enc:")) return encryptedValue;
  const buf = Buffer.from(encryptedValue.slice(4), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = Buffer.from(ENC_KEY, "hex");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

/**
 * ISTD / JoFotara e-invoicing credentials for the CALLER'S OWN store only.
 *
 * The tenant-scope comes from the HMAC-signed admin session cookie (same
 * pattern as /api/settings) — never from the client-supplied store header — so
 * a store can only ever read/write its own `tenant_tax_settings` row. Secrets
 * are stored server-side and never returned in full: the GET exposes only the
 * client_id + a masked secret so the UI can show "configured" without echoing
 * the key back into the browser.
 *
 * The same row's tax_number is mirrored onto stores.tax_number so the printed
 * receipt QR stays in sync with what is saved here.
 */

function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 4) return "••••";
  return `${secret.slice(0, 2)}••••${secret.slice(-2)}`;
}

export async function GET(): Promise<Response> {
  const session = await getAdminSession();
  if (!session) {
    return Response.json({ error: "غير مصرح — سجّل دخول كمدير المتجر" }, { status: 401 });
  }
  const { storeId } = session;

  if (!supabase) {
    return Response.json({
      settings: { taxNumber: "", istdClientId: "", istdSecretMasked: "", configured: false },
    });
  }

  const { data, error } = await supabase
    .from("tenant_tax_settings")
    .select("tax_number,istd_client_id,istd_client_secret")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const taxNumber = data?.tax_number ?? "";
  const istdClientId = data?.istd_client_id ?? "";
  const istdClientSecret = data?.istd_client_secret ? decryptSecret(data.istd_client_secret) : "";
  return Response.json({
    settings: {
      taxNumber,
      istdClientId,
      istdSecretMasked: maskSecret(istdClientSecret),
      configured:
        taxNumber.trim().length > 0 &&
        istdClientId.trim().length > 0 &&
        istdClientSecret.trim().length > 0,
    },
  });
}

export async function PUT(request: Request): Promise<Response> {
  const session = await getAdminSession();
  if (!session) {
    return Response.json({ error: "غير مصرح — سجّل دخول كمدير المتجر" }, { status: 401 });
  }
  const { storeId } = session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as { tax_number?: unknown; istd_client_id?: unknown; istd_client_secret?: unknown };

  const taxNumber = typeof input.tax_number === "string" ? input.tax_number.trim().slice(0, 30) : "";
  const istdClientId = typeof input.istd_client_id === "string" ? input.istd_client_id.trim().slice(0, 200) : "";
  // Blank secret on save = keep the stored secret unchanged (masked on GET).
  const nextSecret = typeof input.istd_client_secret === "string" ? input.istd_client_secret.trim() : "";

  if (istdClientId && !nextSecret && !supabase) {
    // No DB to consult in mock mode; an empty secret means "not configured".
    return Response.json({
      settings: { taxNumber, istdClientId, istdSecretMasked: "", configured: false },
    });
  }

  if (!supabase) {
    return Response.json({
      settings: {
        taxNumber,
        istdClientId,
        istdSecretMasked: nextSecret ? maskSecret(nextSecret) : "",
        configured: Boolean(taxNumber && istdClientId && nextSecret),
      },
    });
  }

  const { data: existing } = await supabase
    .from("tenant_tax_settings")
    .select("istd_client_secret")
    .eq("store_id", storeId)
    .maybeSingle();
  const rawSecret = nextSecret || (existing?.istd_client_secret ?? "");
  const istdClientSecret = rawSecret.startsWith("enc:") ? rawSecret : (rawSecret ? encryptSecret(rawSecret) : "");

  if (istdClientId && !istdClientSecret) {
    return Response.json({ error: "مفتاح JoFotara السري مطلوب" }, { status: 400 });
  }

  const { error: upsertError } = await supabase
    .from("tenant_tax_settings")
    .upsert(
      { store_id: storeId, tax_number: taxNumber, istd_client_id: istdClientId, istd_client_secret: istdClientSecret },
      { onConflict: "store_id" },
    );
  if (upsertError) return Response.json({ error: upsertError.message }, { status: 500 });

  // Keep the store's fiscal number used by the receipt QR in sync.
  if (taxNumber) {
    await supabase.from("stores").update({ tax_number: taxNumber }).eq("id", storeId);
  }

  return Response.json({
    settings: {
      taxNumber,
      istdClientId,
      istdSecretMasked: maskSecret(istdClientSecret),
      configured: Boolean(taxNumber && istdClientId && istdClientSecret),
    },
  });
}

export const dynamic = "force-dynamic";
