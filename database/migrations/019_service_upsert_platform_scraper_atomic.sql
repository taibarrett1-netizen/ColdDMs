-- Mirror of remix-of-skedulemore-dashboard/supabase/migrations/20260414120000_service_upsert_platform_scraper_atomic.sql
-- Apply one of these to your Supabase project (not both if they share the same DB).

CREATE OR REPLACE FUNCTION public.service_upsert_platform_scraper_from_connect(
  p_username text,
  p_session_data jsonb,
  p_daily_limit int,
  p_backup_slot boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_key text;
  n int;
  oldest_id uuid;
  newest_id uuid;
  new_id uuid;
BEGIN
  v_key := lower(trim(both '@' from trim(COALESCE(p_username, ''))));
  IF length(v_key) < 1 THEN
    RAISE EXCEPTION 'username required' USING ERRCODE = '22023';
  END IF;

  IF p_session_data IS NULL OR p_session_data = 'null'::jsonb THEN
    RAISE EXCEPTION 'session_data required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(884301, hashtext('cold_dm_ps:' || v_key));

  SELECT COUNT(*)::int INTO n
  FROM public.cold_dm_platform_scraper_sessions
  WHERE lower(trim(both '@' from trim(instagram_username))) = v_key;

  IF NOT p_backup_slot THEN
    SELECT id INTO oldest_id
    FROM public.cold_dm_platform_scraper_sessions
    WHERE lower(trim(both '@' from trim(instagram_username))) = v_key
    ORDER BY created_at ASC
    LIMIT 1;
    IF oldest_id IS NOT NULL THEN
      UPDATE public.cold_dm_platform_scraper_sessions
      SET session_data = p_session_data,
          daily_actions_limit = GREATEST(1, COALESCE(p_daily_limit, 500)),
          updated_at = now()
      WHERE id = oldest_id;
      RETURN jsonb_build_object('id', oldest_id, 'action', 'update_oldest');
    END IF;
    INSERT INTO public.cold_dm_platform_scraper_sessions (instagram_username, session_data, daily_actions_limit, updated_at)
    VALUES (v_key, p_session_data, GREATEST(1, COALESCE(p_daily_limit, 500)), now())
    RETURNING id INTO new_id;
    RETURN jsonb_build_object('id', new_id, 'action', 'insert');
  END IF;

  IF n >= 2 THEN
    SELECT id INTO newest_id
    FROM public.cold_dm_platform_scraper_sessions
    WHERE lower(trim(both '@' from trim(instagram_username))) = v_key
    ORDER BY created_at DESC
    LIMIT 1;
    UPDATE public.cold_dm_platform_scraper_sessions
    SET session_data = p_session_data,
        daily_actions_limit = GREATEST(1, COALESCE(p_daily_limit, 500)),
        updated_at = now()
    WHERE id = newest_id;
    RETURN jsonb_build_object('id', newest_id, 'action', 'update_newest');
  END IF;

  INSERT INTO public.cold_dm_platform_scraper_sessions (instagram_username, session_data, daily_actions_limit, updated_at)
  VALUES (v_key, p_session_data, GREATEST(1, COALESCE(p_daily_limit, 500)), now())
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'action', 'insert_backup');
END;
$$;

REVOKE ALL ON FUNCTION public.service_upsert_platform_scraper_from_connect(text, jsonb, int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_upsert_platform_scraper_from_connect(text, jsonb, int, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_prune_platform_scraper_duplicates_for_username(p_username text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  deleted int := 0;
BEGIN
  v_key := lower(trim(both '@' from trim(COALESCE(p_username, ''))));
  IF length(v_key) < 1 THEN
    RAISE EXCEPTION 'username required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.admin_users au WHERE au.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  WITH ranked AS (
    SELECT
      id,
      COUNT(*) OVER () AS cnt,
      row_number() OVER (ORDER BY created_at ASC) AS rn_asc,
      row_number() OVER (ORDER BY created_at DESC) AS rn_desc
    FROM public.cold_dm_platform_scraper_sessions
    WHERE lower(trim(both '@' from trim(instagram_username))) = v_key
  ),
  doomed AS (
    SELECT id FROM ranked WHERE cnt > 2 AND rn_asc > 1 AND rn_desc > 1
  )
  DELETE FROM public.cold_dm_platform_scraper_sessions s
  USING doomed d
  WHERE s.id = d.id;
  GET DIAGNOSTICS deleted = ROW_COUNT;

  RETURN jsonb_build_object('deleted_rows', deleted, 'username', v_key);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_prune_platform_scraper_duplicates_for_username(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_prune_platform_scraper_duplicates_for_username(text) TO authenticated;
