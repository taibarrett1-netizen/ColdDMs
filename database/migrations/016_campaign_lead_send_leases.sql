-- Lease fields for campaign leads to support multi-send workers without duplicate claims.
ALTER TABLE public.cold_dm_campaign_leads
  ADD COLUMN IF NOT EXISTS leased_until timestamptz,
  ADD COLUMN IF NOT EXISTS leased_by_worker text,
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_campaign_leads_claim
  ON public.cold_dm_campaign_leads (campaign_id, status, leased_until, id);
