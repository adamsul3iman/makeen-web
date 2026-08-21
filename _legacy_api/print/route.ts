import { supabase } from "@/lib/supabase";
import { authorizedStoreId } from "@/lib/requestAuth";
import { MOCK_STORE_ID } from "@/lib/tenant";
import { renderShiftPrintHtml, type PrintJobKind } from "@/lib/printRenderer";
import type { ShiftAudit } from "@/types/shifts.types";

export const dynamic = "force-dynamic";

/**
 * POST /api/print
 *
 * Queue a print job for the local print agent.
 *
 * Body:
 *   terminal_id  – uuid of the target terminal (must exist in DB)
 *   job_type     – "Z_REPORT" | "X_REPORT" | "RECEIPT" | "INVOICE"
 *   shift        – ShiftAudit payload (required for Z_REPORT / X_REPORT)
 *   printer_kind – "THERMAL" | "A4"  (optional — auto-detected from job_type)
 *
 * Response:
 *   { success: true, job_id: string }
 *   { success: false, error: string }
 */
export async function POST(request: Request): Promise<Response> {
  /* ── 1. Parse body ──────────────────────────────────────────────── */
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "invalid_json" }, { status: 400 });
  }

  const {
    terminal_id,
    job_type,
    shift,
    rendered_html: clientHtml,
    printer_kind: printerKindInput,
  } = body as {
    terminal_id?: unknown;
    job_type?: unknown;
    shift?: unknown;
    rendered_html?: unknown;
    printer_kind?: unknown;
  };

  if (typeof terminal_id !== "string" || terminal_id.length === 0) {
    return Response.json({ success: false, error: "terminal_id_required" }, { status: 400 });
  }

  const validJobTypes: PrintJobKind[] = ["Z_REPORT", "X_REPORT", "RECEIPT", "INVOICE"];
  if (typeof job_type !== "string" || !validJobTypes.includes(job_type as PrintJobKind)) {
    return Response.json(
      { success: false, error: `job_type_invalid — expected one of: ${validJobTypes.join(", ")}` },
      { status: 400 },
    );
  }

  const kind = job_type as PrintJobKind;

  /* ── 2. Auth ────────────────────────────────────────────────────── */
  const storeAccess = supabase ? await authorizedStoreId(request) : null;
  const storeId = typeof storeAccess === "string" ? storeAccess : MOCK_STORE_ID;
  if (!supabase) {
    if (storeAccess instanceof Response) return storeAccess;
  } else if (storeAccess instanceof Response) {
    return storeAccess;
  }

  /* ── 3. Validate terminal exists in this store ──────────────────── */
  if (supabase) {
    const { data: terminal, error: termErr } = await supabase
      .from("terminals")
      .select("id, branch_id, device_config")
      .eq("id", terminal_id)
      .maybeSingle();

    if (termErr) {
      return Response.json(
        { success: false, error: `terminal_lookup_failed: ${termErr.message}` },
        { status: 500 },
      );
    }
    if (!terminal) {
      return Response.json(
        { success: false, error: "terminal_not_found" },
        { status: 404 },
      );
    }

    // Verify the terminal belongs to the same store (via branch)
    const { data: branch } = await supabase
      .from("branches")
      .select("id")
      .eq("id", terminal.branch_id)
      .eq("store_id", storeId)
      .maybeSingle();

    if (!branch) {
      return Response.json(
        { success: false, error: "terminal_does_not_belong_to_store" },
        { status: 403 },
      );
    }
  }

  /* ── 4. Auto-detect printer_kind ────────────────────────────────── */
  let printerKind: string | null = typeof printerKindInput === "string" ? printerKindInput : null;
  if (!printerKind) {
    printerKind = kind === "Z_REPORT" || kind === "X_REPORT" ? "THERMAL" : "A4";
  }

  /* ── 5. Render HTML ────────────────────────────────────────────── */
  let renderedHtml: string;
  try {
    if (kind === "Z_REPORT" || kind === "X_REPORT") {
      if (!shift || typeof shift !== "object") {
        return Response.json(
          { success: false, error: "shift_payload_required_for_report" },
          { status: 400 },
        );
      }
      renderedHtml = renderShiftPrintHtml(shift as ShiftAudit, kind);
    } else {
      // RECEIPT / INVOICE — accept pre-rendered HTML from the client.
      // The POS ThermalReceipt component renders the full receipt DOM
      // client-side; the caller extracts innerHTML and sends it here so
      // the agent can pipe it to the thermal printer without a browser dialog.
      if (typeof clientHtml !== "string" || clientHtml.length === 0) {
        return Response.json(
          { success: false, error: "rendered_html_required_for_receipt" },
          { status: 400 },
        );
      }
      renderedHtml = clientHtml;
    }
  } catch (renderError) {
    return Response.json(
      {
        success: false,
        error: "render_failed",
        detail: renderError instanceof Error ? renderError.message : String(renderError),
      },
      { status: 500 },
    );
  }

  /* ── 6. Insert into print_jobs ──────────────────────────────────── */
  if (!supabase) {
    // Mock mode — return a fake job ID
    return Response.json({ success: true, job_id: "mock-job-" + Date.now(), mocked: true });
  }

  const { data: job, error: insertErr } = await supabase
    .from("print_jobs")
    .insert({
      store_id: storeId,
      kind,
      status: "QUEUED",
      printer_kind: printerKind,
      rendered_html: renderedHtml,
      terminal_id,
      payload: { shift, job_type: kind },
    })
    .select("id")
    .maybeSingle();

  if (insertErr) {
    return Response.json(
      { success: false, error: `insert_failed: ${insertErr.message}` },
      { status: 500 },
    );
  }

  return Response.json({ success: true, job_id: job?.id ?? null });
}
