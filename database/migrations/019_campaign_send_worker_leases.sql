-- Ensure only one send worker can actively process a campaign at a time.
ALTER TABLE public.cold_dm_campaigns
  ADD COLUMN IF NOT EXISTS send_leased_until timestamptz,
  ADD COLUMN IF NOT EXISTS send_leased_by_worker text,
  ADD COLUMN IF NOT EXISTS send_lease_heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_cold_dm_campaigns_send_lease_pick
  ON public.cold_dm_campaigns (status, send_leased_until, send_lease_heartbeat_at, id);
