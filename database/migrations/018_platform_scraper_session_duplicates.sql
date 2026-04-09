-- Allow intentional duplicate platform scraper rows for overflow capacity.
-- The oldest row per instagram_username is treated as primary; newer rows become backup slots.

ALTER TABLE public.cold_dm_platform_scraper_sessions
  DROP CONSTRAINT IF EXISTS cold_dm_platform_scraper_sessions_instagram_username_key;

DROP INDEX IF EXISTS public.idx_platform_scraper_username;

CREATE INDEX IF NOT EXISTS idx_platform_scraper_username_nonunique
  ON public.cold_dm_platform_scraper_sessions(instagram_username);
