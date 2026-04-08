-- Allow scrape_type 'following' (mirror remix migration 20260409103000).
ALTER TABLE public.cold_dm_scrape_jobs
  DROP CONSTRAINT IF EXISTS cold_dm_scrape_jobs_scrape_type_check;

ALTER TABLE public.cold_dm_scrape_jobs
  ADD CONSTRAINT cold_dm_scrape_jobs_scrape_type_check
  CHECK (scrape_type IN ('followers', 'following', 'comments'));

COMMENT ON COLUMN public.cold_dm_scrape_jobs.scrape_type IS
  'followers = scrape target''s followers; following = scrape accounts the target follows; comments = scrape commenters on posts';
