# Prompt for dashboard repo: message variables (first name, last name, username, full name)

Give this to the dashboard repo so they can add schema, UI, and docs for Cold DM message variables.

---

**Prompt:**

We need to support **message variables** in Cold DM so templates can personalize by lead. The VPS already substitutes these when sending:

- **Supported variables (use exactly in message text):**
  - `{{username}}` or `{{instagram_username}}` – lead’s Instagram handle (no @)
  - `{{first_name}}` – lead’s first name (from DB or derived from username)
  - `{{last_name}}` – lead’s last name (from DB or derived from username)
  - `{{full_name}}` – `first_name + " " + last_name`, or username if neither is set

If `first_name` / `last_name` are not stored for a lead, the VPS derives them from the username (e.g. `john_doe` → First name: John, Last name: Doe).

**What the dashboard must do:**

1. **Schema**  
   Add nullable columns to `cold_dm_leads`: `first_name` (TEXT), `last_name` (TEXT).  
   Example migration (run in same Supabase project as Cold DM):

   ```sql
   ALTER TABLE public.cold_dm_leads
     ADD COLUMN IF NOT EXISTS first_name TEXT,
     ADD COLUMN IF NOT EXISTS last_name TEXT;
   ```

2. **Leads UI**  
   - In the Cold Outreach / Leads area, allow viewing and editing **First name** and **Last name** per lead (optional fields).  
   - When adding or importing leads (e.g. CSV or scraper results), support optional `first_name` and `last_name` columns so we can store them.  
   - If not provided, the VPS will still substitute using the username (as above).

3. **Message composer UI (templates / message groups)**  
   - Where users write the DM text (templates or message group messages), show the list of supported variables (e.g. in a tooltip, help text, or “Insert variable” dropdown):  
     `{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{username}}`.  
   - Optionally: “Insert variable” buttons or dropdown that insert the placeholder at the cursor so users don’t have to type `{{...}}` by hand.

4. **Docs**  
   In your Cold DM / Cold Outreach help or copy, briefly explain that users can use these placeholders in messages and that first/last name can be set on leads for better personalization; if left blank, names are derived from the Instagram username.

No API changes are required: the VPS reads `first_name` and `last_name` from `cold_dm_leads` when building the message and performs substitution before sending.
