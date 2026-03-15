-- First-name blocklist: when a lead's resolved first name is in this list (case-insensitive),
-- {{first_name}} is substituted as empty so the message doesn't use that name.
-- One row per (client_id, first_name_lower).

CREATE TABLE IF NOT EXISTS public.cold_dm_first_name_blocklist (
  client_id UUID NOT NULL,
  first_name_lower TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (client_id, first_name_lower)
);

CREATE INDEX IF NOT EXISTS idx_cold_dm_first_name_blocklist_client_id
  ON public.cold_dm_first_name_blocklist(client_id);

COMMENT ON TABLE public.cold_dm_first_name_blocklist IS 'First names to treat as empty in message templates (e.g. brand names or unwanted fallbacks). Comparison is case-insensitive.';
