-- Add optional first_name, last_name to cold_dm_leads for message variable substitution.
-- Run in Supabase SQL editor or via migrations. Dashboard repo should add the same columns if it owns the schema.

ALTER TABLE public.cold_dm_leads
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT;
