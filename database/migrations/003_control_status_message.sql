-- Add status_message and status_updated_at to cold_dm_control for dashboard display.
-- The bot updates these when sending, hitting limits, etc.

ALTER TABLE public.cold_dm_control
  ADD COLUMN IF NOT EXISTS status_message TEXT,
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;
