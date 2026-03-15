# Dashboard: First name blocklist UI

Use this in your **other dashboard repo** to add management for the first-name blocklist.

## Backend / Supabase

1. **Run the migration** (if the Cold DM VPS repo hasn’t applied it to your Supabase project already):

```sql
-- First-name blocklist: when a lead's resolved first name is in this list (case-insensitive),
-- {{first_name}} is substituted as empty so the message doesn't use that name.
CREATE TABLE IF NOT EXISTS public.cold_dm_first_name_blocklist (
  client_id UUID NOT NULL,
  first_name_lower TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (client_id, first_name_lower)
);

CREATE INDEX IF NOT EXISTS idx_cold_dm_first_name_blocklist_client_id
  ON public.cold_dm_first_name_blocklist(client_id);

COMMENT ON TABLE public.cold_dm_first_name_blocklist IS 'First names to treat as empty in message templates (e.g. brand names). Comparison is case-insensitive.';
```

2. **RLS (if you use it):** Allow the authenticated user to read/insert/delete only rows where `client_id` equals their user/client id.

3. **API or direct Supabase:** The dashboard needs to:
   - **List** blocklist entries for the current client:  
     `cold_dm_first_name_blocklist` where `client_id = currentClientId`, ordered by `first_name_lower`.
   - **Add** a name: insert `{ client_id, first_name_lower: name.trim().toLowerCase() }`. Ignore or handle unique violation if it already exists.
   - **Remove** a name: delete where `client_id` and `first_name_lower` match.

## UI

- **Where:** e.g. **Settings** or **Message / Templates** (anywhere that applies to the current client).
- **Section:** “First name blocklist” (or “Blocked first names”).
- **Behaviour:**
  - Show a list of blocklisted first names (display in a readable form, e.g. capitalized; store and send as lowercase).
  - “Add name” control: input + add button. On add, normalize to lowercase and insert for current client. Don’t duplicate (either check before insert or ignore unique error).
  - Each row has a remove/delete control; delete that `(client_id, first_name_lower)` row.
- **Help text:**  
  “Names in this list are never used for {{first_name}} in messages. Use this for brand names or handles that look like first names (e.g. Abbybabies, Charliedarbyyatesxo) so the bot doesn’t use them.”

## VPS behaviour (already implemented)

- When building the message, the bot loads the client’s blocklist and passes it to the variable substitution.
- If the resolved first name (from display name or lead’s first_name) matches a blocklist entry (case-insensitive), `{{first_name}}` is replaced with an empty string.
- No fallback to username: if there’s no valid first name (or it’s blocklisted), the message simply has no first name in that placeholder.
