-- Store why a send failed so the dashboard can show it (e.g. user_not_found, messages_restricted, account_private).

ALTER TABLE public.cold_dm_sent_messages
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

ALTER TABLE public.cold_dm_campaign_leads
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

COMMENT ON COLUMN public.cold_dm_sent_messages.failure_reason IS 'When status = failed: reason from VPS e.g. user_not_found, messages_restricted, account_private, rate_limited, no_compose.';
COMMENT ON COLUMN public.cold_dm_campaign_leads.failure_reason IS 'When status = failed: reason from VPS e.g. user_not_found, messages_restricted, account_private.';
