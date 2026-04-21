-- Cold DM send jobs: make the idempotency key conflict target usable by ON CONFLICT.
-- The existing partial unique index protects most inserts, but PostgREST/Supabase
-- cannot infer a partial index for `onConflict: 'client_id,idempotency_key'`.
-- A plain unique index on the same columns lets upserts work again.

DO $$
BEGIN
  -- Remove any accidental duplicates before creating the full unique index.
  DELETE FROM public.cold_dm_send_jobs a
  USING public.cold_dm_send_jobs b
  WHERE a.client_id = b.client_id
    AND a.idempotency_key IS NOT NULL
    AND b.idempotency_key IS NOT NULL
    AND a.idempotency_key = b.idempotency_key
    AND a.ctid < b.ctid;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_send_jobs_idempotency_full
  ON public.cold_dm_send_jobs (client_id, idempotency_key);
