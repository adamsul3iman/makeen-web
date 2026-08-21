-- 060_print_jobs.sql
-- Phase 4 remote barcode printing: a per-store queue of print jobs that the
-- register device enqueues and a dedicated /print-server kiosk (or any
-- browser on the store LAN) drains. Jobs are self-contained — barcode, name,
-- variant label, unit, price, qty and label template size ride in the JSONB
-- payload — so the printer never re-fetches the product and a product rename
-- after the sale can never alter the printed label.
--
-- Lifecycle: QUEUED -> CLAIMED -> PRINTED | FAILED
--   * A worker claims one job at a time via SELECT ... FOR UPDATE SKIP LOCKED
--     so concurrent kiosks never double-print.
--   * A CLAIMED job whose claim goes stale (crashed worker) is requeued.
--   * Each claim costs one attempt; jobs past the attempts cap move to FAILED
--     so a poisoned payload cannot circulate forever.
--   * Jobs expire (default 24h) and are purged with the terminal rows.

-- 1. The queue table.
CREATE TABLE IF NOT EXISTS print_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'BARCODE_LABEL'
              CHECK (kind IN ('BARCODE_LABEL')),
  status      TEXT NOT NULL DEFAULT 'QUEUED'
              CHECK (status IN ('QUEUED', 'CLAIMED', 'PRINTED', 'FAILED')),
  -- Self-contained label content (see payload shape below); the kiosk never
  -- dereferences the product.
  payload     JSONB NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0),
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_worker TEXT,
  -- Sync event that created this job; unique so an offline re-sync of the same
  -- BARCODE_LABEL_PRINT can never double-queue labels.
  source_event_id UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at  TIMESTAMPTZ,
  printed_at  TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);

-- Claim scan: oldest by priority/created_at per store/status.
CREATE INDEX IF NOT EXISTS idx_print_jobs_claim
  ON print_jobs (store_id, status, priority DESC, created_at);
-- Purge scan: terminal rows and expired queued jobs.
CREATE INDEX IF NOT EXISTS idx_print_jobs_purge
  ON print_jobs (status, expires_at);
-- Mirror idempotency: one queued job per source sync event. NULLs stay
-- distinct so legacy jobs without a source event never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_jobs_source_event
  ON print_jobs (source_event_id);

-- 2. claim_print_job: requeue stale claims, fail over-capped jobs, then hand
--    the oldest eligible job to this worker. Atomic: the FOR UPDATE SKIP
--    LOCKED guarantees two workers can never claim the same row, and the
--    whole function runs in one transaction.
CREATE OR REPLACE FUNCTION claim_print_job(
  p_store_id uuid,
  p_worker_id text,
  p_timeout_seconds integer DEFAULT 120,
  p_max_attempts integer DEFAULT 8
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_job print_jobs%ROWTYPE;
BEGIN
  -- A crashed worker leaves the job CLAIMED with an old claimed_at: give it
  -- back to the queue so another kiosk can print it.
  UPDATE print_jobs
  SET status = 'QUEUED', claimed_at = NULL
  WHERE store_id = p_store_id
    AND status = 'CLAIMED'
    AND claimed_at < now() - make_interval(secs => p_timeout_seconds);

  -- Jobs whose claim budget is exhausted stop circulating and surface as
  -- FAILED so the owner can see and requeue them.
  UPDATE print_jobs
  SET status = 'FAILED'
  WHERE store_id = p_store_id
    AND status = 'QUEUED'
    AND attempts >= p_max_attempts;

  SELECT * INTO v_job
  FROM print_jobs
  WHERE store_id = p_store_id
    AND status = 'QUEUED'
    AND attempts < p_max_attempts
    AND expires_at > now()
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE print_jobs
  SET status = 'CLAIMED',
      claimed_at = now(),
      attempts = attempts + 1,
      last_worker = p_worker_id
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'id', v_job.id,
    'kind', v_job.kind,
    'payload', v_job.payload,
    'priority', v_job.priority,
    'attempts', v_job.attempts,
    'worker', v_job.last_worker,
    'createdAt', v_job.created_at,
    'expiresAt', v_job.expires_at
  );
END;
$$;

-- 3. resolve_print_job: the kiosk confirms the label printed (or failed).
--    Only a CLAIMED job may be resolved; anything else is a no-op, so a
--    double-resolve can never overwrite a later state.
CREATE OR REPLACE FUNCTION resolve_print_job(
  p_store_id uuid,
  p_job_id uuid,
  p_printed boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE print_jobs
  SET status = CASE WHEN p_printed THEN 'PRINTED' ELSE 'FAILED' END,
      printed_at = CASE WHEN p_printed THEN now() ELSE printed_at END
  WHERE id = p_job_id
    AND store_id = p_store_id
    AND status = 'CLAIMED'
  RETURNING status INTO v_status;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

-- 4. purge_print_jobs: drop terminal rows after their grace window plus any
--    row whose expiry passed (stuck QUEUED jobs cannot accumulate forever).
CREATE OR REPLACE FUNCTION purge_print_jobs(
  p_store_id uuid,
  p_older_than interval DEFAULT interval '24 hours'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM print_jobs
  WHERE store_id = p_store_id
    AND (expires_at < now() OR status IN ('PRINTED', 'FAILED'))
    AND created_at < now() - p_older_than;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- 5. BARCODE_LABEL payload shape (documented here so the client and the kiosk
--    never drift):
--    payload = {
--      barcode: string,
--      name: string,
--      variantLabel?: string,
--      unitName: string,
--      price: number,
--      quantity: number,
--      templateSize: { widthMm: number, heightMm: number }
--    }
