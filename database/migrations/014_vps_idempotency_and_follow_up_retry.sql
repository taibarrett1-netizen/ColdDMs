-- VPS follow-up idempotency (dedupe retries / double cron) + cold outreach follow-up retry counter.

CREATE TABLE IF NOT EXISTS public.cold_dm_vps_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  route text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, route, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_cold_dm_vps_idem_created ON public.cold_dm_vps_idempotency (created_at);

ALTER TABLE public.cold_dm_follow_up_queue
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

-- Deny direct client access; VPS uses service role only.
ALTER TABLE public.cold_dm_vps_idempotency ENABLE ROW LEVEL SECURITY;
