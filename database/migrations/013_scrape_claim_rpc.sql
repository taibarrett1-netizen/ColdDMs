-- Parallel-safe cold DM queue + atomic scrape claim (apply via `supabase db push` from remix repo).
-- Idempotent: safe if pieces already applied from Cold DMs V1 migrations.

-- 1) Scrape job lease columns + status check
ALTER TABLE public.cold_dm_scrape_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS leased_by_worker TEXT,
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_class TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cold_dm_scrape_jobs_status_check'
      AND conrelid = 'public.cold_dm_scrape_jobs'::regclass
  ) THEN
    ALTER TABLE public.cold_dm_scrape_jobs DROP CONSTRAINT cold_dm_scrape_jobs_status_check;
  END IF;
END $$;

ALTER TABLE public.cold_dm_scrape_jobs
  ADD CONSTRAINT cold_dm_scrape_jobs_status_check
  CHECK (status IN ('pending','leased','running','retry','completed','failed','cancelled'));

UPDATE public.cold_dm_scrape_jobs
SET status = 'pending'
WHERE status = 'running'
  AND finished_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scrape_jobs_queue_pick
  ON public.cold_dm_scrape_jobs (status, leased_until, started_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scrape_jobs_idempotency
  ON public.cold_dm_scrape_jobs (client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2) Platform scraper session rotation
ALTER TABLE public.cold_dm_platform_scraper_sessions
  ADD COLUMN IF NOT EXISTS account_state TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS leased_by_worker TEXT,
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hourly_actions_limit INTEGER NOT NULL DEFAULT 60;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cold_dm_platform_scraper_sessions_account_state_check'
      AND conrelid = 'public.cold_dm_platform_scraper_sessions'::regclass
  ) THEN
    ALTER TABLE public.cold_dm_platform_scraper_sessions
      DROP CONSTRAINT cold_dm_platform_scraper_sessions_account_state_check;
  END IF;
END $$;

ALTER TABLE public.cold_dm_platform_scraper_sessions
  ADD CONSTRAINT cold_dm_platform_scraper_sessions_account_state_check
  CHECK (account_state IN ('active','cooldown','quarantined','reauth_required','disabled'));

CREATE INDEX IF NOT EXISTS idx_platform_scraper_rotation_pick
  ON public.cold_dm_platform_scraper_sessions (account_state, cooldown_until, leased_until, risk_score, id);

-- 3) Send job queue (future multi-send workers)
CREATE TABLE IF NOT EXISTS public.cold_dm_send_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES public.cold_dm_campaigns(id) ON DELETE SET NULL,
  campaign_lead_id UUID REFERENCES public.cold_dm_campaign_leads(id) ON DELETE SET NULL,
  instagram_session_id UUID REFERENCES public.cold_dm_instagram_sessions(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','running','retry','completed','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  leased_until TIMESTAMPTZ,
  leased_by_worker TEXT,
  lease_heartbeat_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  idempotency_key TEXT,
  last_error_class TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_send_jobs_queue_pick
  ON public.cold_dm_send_jobs (status, available_at, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_send_jobs_client_status
  ON public.cold_dm_send_jobs (client_id, status, available_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_send_jobs_idempotency
  ON public.cold_dm_send_jobs (client_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.cold_dm_worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  worker_type TEXT NOT NULL CHECK (worker_type IN ('send','scrape','scheduler')),
  host TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4) RPC: claim + heartbeat (service_role only)
CREATE OR REPLACE FUNCTION public.claim_cold_dm_scrape_job(p_worker_id text, p_lease_seconds integer)
RETURNS SETOF public.cold_dm_scrape_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lease interval;
BEGIN
  lease := make_interval(secs => GREATEST(30, LEAST(COALESCE(NULLIF(p_lease_seconds, 0), 180), 3600)));
  RETURN QUERY
  WITH picked AS (
    SELECT id
    FROM public.cold_dm_scrape_jobs
    WHERE status = 'pending'
    ORDER BY started_at ASC NULLS LAST
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.cold_dm_scrape_jobs j
  SET
    status = 'running',
    leased_by_worker = p_worker_id,
    leased_until = NOW() + lease,
    lease_heartbeat_at = NOW(),
    attempt_count = j.attempt_count + 1
  FROM picked
  WHERE j.id = picked.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_cold_dm_scrape_job(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_cold_dm_scrape_job(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.heartbeat_cold_dm_scrape_job(p_job_id uuid, p_worker_id text, p_lease_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lease interval;
  updated int;
BEGIN
  lease := make_interval(secs => GREATEST(30, LEAST(COALESCE(NULLIF(p_lease_seconds, 0), 180), 3600)));
  UPDATE public.cold_dm_scrape_jobs
  SET
    leased_until = NOW() + lease,
    lease_heartbeat_at = NOW()
  WHERE id = p_job_id
    AND leased_by_worker = p_worker_id
    AND status = 'running';
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.heartbeat_cold_dm_scrape_job(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.heartbeat_cold_dm_scrape_job(uuid, text, integer) TO service_role;
