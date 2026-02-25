-- Per-campaign timezone for schedule window. When null, schedule uses UTC.
-- Schedule and "can run" use this campaign timezone, not cold_dm_settings.timezone.

ALTER TABLE public.cold_dm_campaigns
  ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN public.cold_dm_campaigns.timezone IS 'IANA timezone (e.g. America/New_York) for schedule_start_time/schedule_end_time. Null = UTC.';
