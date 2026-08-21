/**
 * Supabase Realtime listener for print_jobs.
 *
 * Subscribes to INSERT events on the print_jobs table filtered by
 * terminal_id. When a new QUEUED job appears, claims and processes it.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AgentConfig } from "./config";
import { htmlToPdf, spoolToPrinter, closeBrowser } from "./spooler";

type LogFn = (level: string, msg: string, meta?: Record<string, unknown>) => void;

interface PrintJobRow {
  id: string;
  store_id: string;
  kind: string;
  status: string;
  printer_kind: string | null;
  rendered_html: string | null;
  terminal_id: string | null;
  payload: Record<string, unknown>;
  priority: number;
  attempts: number;
}

export interface ListenerHandle {
  stop: () => void;
}

export function startListener(
  config: AgentConfig,
  log: LogFn,
): ListenerHandle {
  const supabase: SupabaseClient = createClient(
    config.supabaseUrl,
    config.supabaseKey,
    { auth: { persistSession: false } },
  );

  let stopped = false;
  let processing = 0;
  const MAX_CONCURRENT = 1; // one job at a time

  // ── Health-check HTTP server ──────────────────────────────────────────
  const http = require("http") as typeof import("http");
  const server = http.createServer((_req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
    if (_req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        terminal_id: config.terminalId,
        thermal_printer: config.thermalPrinter,
        a4_printer: config.a4Printer,
        processing,
        uptime: process.uptime(),
      }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(config.port, "0.0.0.0", () => {
    log("info", `Health server listening on :${config.port}`);
  });

  // ── Process a single job ─────────────────────────────────────────────
  async function processJob(job: PrintJobRow): Promise<void> {
    const jobId = job.id;
    const printerKind = job.printer_kind ?? "THERMAL";

    // Pick the printer name based on kind
    const printerName =
      printerKind === "A4" ? config.a4Printer : config.thermalPrinter;

    log("info", `Processing job ${jobId}`, {
      kind: job.kind,
      printerKind,
      printerName,
    });

    // 1. Claim via RPC
    const { data: claimed, error: claimErr } = await supabase.rpc(
      "claim_print_job",
      {
        p_store_id: job.store_id,
        p_worker_id: `agent-${config.terminalId}`,
        p_terminal_id: config.terminalId,
      },
    );

    if (claimErr) {
      log("error", `Claim failed for ${jobId}`, { error: claimErr.message });
      return;
    }

    if (!claimed) {
      log("warn", `Job ${jobId} was not claimable (already claimed or gone)`);
      return;
    }

    // 2. Fetch rendered_html if not in the realtime payload
    let html = job.rendered_html;
    if (!html) {
      const { data: row, error: fetchErr } = await supabase
        .from("print_jobs")
        .select("rendered_html")
        .eq("id", jobId)
        .maybeSingle();

      if (fetchErr || !row?.rendered_html) {
        log("error", `No rendered_html for job ${jobId}`, {
          error: fetchErr?.message,
        });
        await resolveJob(supabase, jobId, false);
        return;
      }
      html = row.rendered_html;
    }

    // 3. HTML → PDF
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await htmlToPdf(html!, printerKind, log);
    } catch (renderErr) {
      log("error", `PDF render failed for ${jobId}`, {
        error: renderErr instanceof Error ? renderErr.message : String(renderErr),
      });
      await resolveJob(supabase, jobId, false);
      return;
    }

    // 4. Spool to printer
    try {
      await spoolToPrinter(pdfBuffer, printerName, jobId);
      log("info", `Printed job ${jobId} to ${printerName}`);
      await resolveJob(supabase, jobId, true);
    } catch (printErr) {
      log("error", `Print failed for ${jobId}`, {
        error: printErr instanceof Error ? printErr.message : String(printErr),
      });
      await resolveJob(supabase, jobId, false);
    }
  }

  // ── Drain queue on startup (pick up any QUEUED jobs from before restart)
  async function drainQueue(): Promise<void> {
    try {
      const { data: jobs, error } = await supabase.rpc("claim_print_job", {
        p_store_id: await getStoreId(supabase, config.terminalId),
        p_worker_id: `agent-${config.terminalId}`,
        p_terminal_id: config.terminalId,
      });

      if (error || !jobs) return;

      // claim_print_job returns a single job or null
      const job = jobs as unknown as PrintJobRow;
      if (job && job.id) {
        log("info", `Drained queued job ${job.id}`);
        await processJob(job);
      }
    } catch {
      // Best-effort drain — don't crash
    }
  }

  // ── Supabase Realtime subscription ───────────────────────────────────
  const channel = supabase
    .channel(`print-jobs-${config.terminalId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "print_jobs",
        filter: `terminal_id=eq.${config.terminalId}`,
      },
      async (payload) => {
        if (stopped) return;
        if (processing >= MAX_CONCURRENT) {
          log("warn", "Agent busy, skipping realtime trigger — drain will catch it");
          return;
        }
        processing++;
        try {
          const job = payload.new as PrintJobRow;
          await processJob(job);
        } finally {
          processing--;
        }
      },
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "print_jobs",
        // Also catch jobs with NULL terminal_id (legacy barcode jobs)
        // that the agent should still process if it's the print-server.
      },
      () => {
        // Intentional no-op — legacy jobs handled by the kiosk page.
      },
    )
    .subscribe((status) => {
      log("info", `Realtime channel status: ${status}`);
    });

  // ── Initial drain after a short delay ─────────────────────────────────
  setTimeout(() => {
    void drainQueue();
  }, 3_000);

  // ── Periodic drain (every 30s) as a safety net ────────────────────────
  const drainInterval = setInterval(() => {
    if (stopped) return;
    if (processing >= MAX_CONCURRENT) return;
    processing++;
    void drainQueue().finally(() => { processing--; });
  }, 30_000);

  // ── Stop handler ──────────────────────────────────────────────────────
  async function stop(): Promise<void> {
    stopped = true;
    clearInterval(drainInterval);
    await supabase.removeChannel(channel);
    await closeBrowser();
    server.close();
    log("info", "Listener stopped");
  }

  return { stop };
}

// ── Helpers ────────────────────────────────────────────────────────────

async function getStoreId(
  supabase: SupabaseClient,
  terminalId: string,
): Promise<string> {
  const { data } = await supabase
    .from("terminals")
    .select("branch_id")
    .eq("id", terminalId)
    .maybeSingle();

  if (!data?.branch_id) return "";

  const { data: branch } = await supabase
    .from("branches")
    .select("store_id")
    .eq("id", data.branch_id)
    .maybeSingle();

  return branch?.store_id ?? "";
}

async function resolveJob(
  supabase: SupabaseClient,
  jobId: string,
  printed: boolean,
): Promise<void> {
  // We need the store_id — fetch from the job row
  const { data: job } = await supabase
    .from("print_jobs")
    .select("store_id")
    .eq("id", jobId)
    .maybeSingle();

  if (!job?.store_id) return;

  await supabase.rpc("resolve_print_job", {
    p_store_id: job.store_id,
    p_job_id: jobId,
    p_printed: printed,
  });
}
