-- Platform scraper pool for rotation. Run this in Supabase SQL editor or via migrations.
-- Dashboard repo may have its own migrations; ensure this runs before using platform scrapers.

CREATE TABLE IF NOT EXISTS public.cold_dm_platform_scraper_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_data JSONB NOT NULL,
  instagram_username TEXT NOT NULL UNIQUE,
  daily_actions_limit INT NOT NULL DEFAULT 500,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_scraper_username ON public.cold_dm_platform_scraper_sessions(instagram_username);

CREATE TABLE IF NOT EXISTS public.cold_dm_scraper_daily_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_scraper_session_id UUID NOT NULL REFERENCES public.cold_dm_platform_scraper_sessions(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  actions_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform_scraper_session_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_scraper_daily_usage_session_date ON public.cold_dm_scraper_daily_usage(platform_scraper_session_id, usage_date);

ALTER TABLE public.cold_dm_scrape_jobs
  ADD COLUMN IF NOT EXISTS platform_scraper_session_id UUID REFERENCES public.cold_dm_platform_scraper_sessions(id);
