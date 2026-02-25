-- Fast leads total + remaining for /api/status (avoids fetching all rows).
CREATE OR REPLACE FUNCTION public.get_cold_dm_leads_counts(p_client_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*)::int FROM public.cold_dm_leads WHERE client_id = p_client_id),
    'remaining', (
      SELECT COUNT(*)::int
      FROM public.cold_dm_leads l
      WHERE l.client_id = p_client_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.cold_dm_sent_messages s
          WHERE s.client_id = l.client_id
            AND LOWER(TRIM(BOTH '@' FROM s.username)) = LOWER(TRIM(BOTH '@' FROM l.username))
        )
    )
  );
$$;
