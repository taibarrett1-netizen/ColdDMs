-- Parallel-safe send sessions.
-- One send worker may lease one Instagram account/session at a time.

ALTER TABLE public.cold_dm_instagram_sessions
  ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS leased_by_worker TEXT,
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_instagram_sessions_lease_pick
  ON public.cold_dm_instagram_sessions (client_id, leased_until, id);
