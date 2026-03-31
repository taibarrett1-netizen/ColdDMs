-- Remove legacy client-level scraper sessions; platform scraper pool is now admin-managed only.
DELETE FROM public.cold_dm_scraper_sessions;
