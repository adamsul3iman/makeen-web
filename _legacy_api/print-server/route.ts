import { supabase } from "@/lib/supabase";
import { authorizedStoreId } from "@/lib/requestAuth";
import { MOCK_STORE_ID } from "@/lib/tenant";

/**
 * Drain endpoint for the /print-server kiosk.
 *
 * POST { action: "claim" }            → claim the oldest eligible label job
 * POST { action: "resolve", jobId, printed? } → mark it printed / failed
 * POST { action: "purge" }            → drop terminal + expired jobs (housekeeping)
 *
 * Claiming goes through the `claim_print_job` RPC whose SELECT ... FOR UPDATE
 * SKIP LOCKED guarantees two kiosks can never print the same label. In mock
 * mode (no Supabase) a simulated round-trip keeps local development working.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "invalid_json" }, { status: 400 });
  }
  const action = (body as { action?: unknown })?.action;
  if (typeof action !== "string") {
    return Response.json({ success: false, error: "action_required" }, { status: 400 });
  }

  const storeAccess = supabase ? await authorizedStoreId(request) : null;
  const storeId = typeof storeAccess === "string" ? storeAccess : MOCK_STORE_ID;
  if (!supabase) {
    if (storeAccess instanceof Response) return storeAccess;
    return mockResult(action, body as Record<string, unknown>);
  }
  if (storeAccess instanceof Response) return storeAccess;
  if (!storeId) {
    return Response.json({ success: false, error: "store_session_required" }, { status: 401 });
  }

  switch (action) {
    case "claim": {
      const { data, error } = await supabase.rpc("claim_print_job", {
        p_store_id: storeId,
        p_worker_id: typeof (body as { workerId?: unknown }).workerId === "string"
          ? (body as { workerId: string }).workerId
          : "print-server",
        p_timeout_seconds: 120,
        p_max_attempts: 8,
      });
      if (error) {
        return Response.json({ success: false, error: error.message }, { status: 500 });
      }
      if (!data) {
        return Response.json({ success: true, job: null });
      }
      return Response.json({ success: true, job: data });
    }
    case "resolve": {
      const { jobId, printed } = body as { jobId?: unknown; printed?: unknown };
      if (typeof jobId !== "string" || jobId.length === 0) {
        return Response.json({ success: false, error: "job_id_required" }, { status: 400 });
      }
      const { data, error } = await supabase.rpc("resolve_print_job", {
        p_store_id: storeId,
        p_job_id: jobId,
        p_printed: printed === false ? false : true,
      });
      if (error) {
        return Response.json({ success: false, error: error.message }, { status: 500 });
      }
      return Response.json({ success: true, result: data });
    }
    case "purge": {
      const { data, error } = await supabase.rpc("purge_print_jobs", {
        p_store_id: storeId,
        p_older_than: "24 hours",
      });
      if (error) {
        return Response.json({ success: false, error: error.message }, { status: 500 });
      }
      return Response.json({ success: true, purged: data });
    }
    default:
      return Response.json({ success: false, error: "unknown_action" }, { status: 400 });
  }
}

/** Simulated drain for local development without Supabase. */
function mockResult(action: string, body: Record<string, unknown>): Response {
  switch (action) {
    case "claim":
      return Response.json({ success: true, job: null });
    case "resolve":
      return Response.json({ success: true, result: { ok: true, status: body.printed === false ? "FAILED" : "PRINTED" } });
    case "purge":
      return Response.json({ success: true, purged: 0 });
    default:
      return Response.json({ success: false, error: "unknown_action" }, { status: 400 });
  }
}
