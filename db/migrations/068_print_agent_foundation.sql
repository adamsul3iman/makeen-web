-- Migration 068: Local Print Agent foundation
-- Adds device_config to terminals for printer binding.
-- Extends print_jobs with printer_kind, rendered_html, terminal_id
-- for thermal/A4 receipt printing (not just barcode labels).

-- ================================================================
-- 1. TERMINALS: add device_config JSONB
-- ================================================================
ALTER TABLE terminals
  ADD COLUMN IF NOT EXISTS device_config JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN terminals.device_config IS
  'Per-terminal local device settings managed by the print agent. '
  'Example: {"thermal_printer":"Rongta RP80","a4_printer":"HP LaserJet",'
  '"receipt_width":80,"agent_endpoint":"http://localhost:9100"}';

-- ================================================================
-- 2. PRINT_JOBS: extend for receipt / report printing
-- ================================================================

-- Widen the kind CHECK to accept receipt and report types
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_kind_check
  CHECK (kind IN ('BARCODE_LABEL', 'RECEIPT', 'Z_REPORT', 'X_REPORT', 'INVOICE'));

-- New columns (nullable so existing barcode-label rows are unaffected)
ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS printer_kind text
    CHECK (printer_kind IN ('THERMAL', 'A4', 'LABEL'));

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS rendered_html text;

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS terminal_id uuid REFERENCES terminals(id);

-- Index for the local agent to poll its own terminal's jobs
CREATE INDEX IF NOT EXISTS idx_print_jobs_terminal
  ON print_jobs (terminal_id, status, created_at)
  WHERE terminal_id IS NOT NULL;

-- ================================================================
-- 3. Updated claim_print_job RPC — now filters by terminal_id
-- ================================================================
CREATE OR REPLACE FUNCTION claim_print_job(
  p_store_id    uuid,
  p_worker_id   text DEFAULT 'print-server',
  p_terminal_id uuid DEFAULT NULL,
  p_timeout_seconds int DEFAULT 120,
  p_max_attempts    int DEFAULT 8
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_job jsonb;
BEGIN
  -- Requeue stale CLAIMED jobs
  UPDATE print_jobs
     SET status = 'QUEUED', claimed_at = NULL
   WHERE store_id = p_store_id
     AND status = 'CLAIMED'
     AND claimed_at < now() - (p_timeout_seconds || ' seconds')::interval;

  -- Fail jobs that exceeded max attempts
  UPDATE print_jobs
     SET status = 'FAILED'
   WHERE store_id = p_store_id
     AND status = 'QUEUED'
     AND attempts >= p_max_attempts;

  -- Claim the oldest eligible job (optionally filtered by terminal)
  SELECT to_jsonb(pj.*) INTO v_job
    FROM print_jobs pj
   WHERE pj.store_id = p_store_id
     AND pj.status = 'QUEUED'
     AND (p_terminal_id IS NULL OR pj.terminal_id = p_terminal_id OR pj.terminal_id IS NULL)
   ORDER BY pj.priority DESC, pj.created_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF v_job IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE print_jobs
     SET status = 'CLAIMED',
         last_worker = p_worker_id,
         attempts = attempts + 1,
         claimed_at = now()
   WHERE id = (v_job->>'id')::uuid;

  RETURN v_job;
END;
$$;
