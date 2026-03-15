# Dashboard: Show send failure reason

The Cold DM VPS now stores **why** a send failed in the same tables you already use. Use this in your **dashboard repo** to surface that information.

---

## 1. Schema (run in Supabase if the VPS hasn’t applied it)

The VPS migration `009_failure_reason.sql` adds:

- **cold_dm_sent_messages.failure_reason** (TEXT, nullable)  
  Set when `status = 'failed'`. Example values: `user_not_found`, `messages_restricted`, `account_private`, `rate_limited`, `no_compose`.

- **cold_dm_campaign_leads.failure_reason** (TEXT, nullable)  
  Set when `status = 'failed'`. Same values as above.

Run this if you manage migrations yourself:

```sql
ALTER TABLE public.cold_dm_sent_messages
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

ALTER TABLE public.cold_dm_campaign_leads
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;
```

---

## 2. Where to show it

Show `failure_reason` wherever you already show failed sends or failed campaign leads, in the same place as the rest of the info (username, status, sent_at, etc.):

- **Sent / activity list**  
  When you list rows from `cold_dm_sent_messages`, for rows with `status = 'failed'` show a “Failure reason” or “Why it failed” using `failure_reason` (see human‑friendly labels below).

- **Campaign leads (or “Message group” / per‑campaign view)**  
  When you list campaign leads (e.g. from `cold_dm_campaign_leads` joined to leads), for rows with `status = 'failed'` show the same “Failure reason” from `failure_reason`.

Use the same column in both places so behaviour is consistent.

---

## 3. Human‑friendly labels

Map the raw value to a short label for the UI (and optionally a tooltip). Suggested mapping:

| Value                  | Label (short)              | Tooltip / description (optional) |
|------------------------|----------------------------|-----------------------------------|
| `user_not_found`       | User not found             | Account may be deleted, renamed, or not findable in search. |
| `messages_restricted`  | Messages restricted        | This account only accepts messages from people they follow. |
| `account_private`      | Private account            | Account is private (or similar restriction). |
| `rate_limited`        | Rate limited               | Instagram rate limit; try again later. |
| `no_compose`          | Couldn’t open message box   | Compose area didn’t appear (e.g. restriction or UI change). |
| (null or other)        | Failed                     | Send failed; reason not recorded. |

You can show the short label as text and the tooltip on hover, or in a small “Why?” / “Details” expandable section next to the failed row.

---

## 4. Implementation checklist

- [ ] Add `failure_reason` to the select when loading **cold_dm_sent_messages** (and to any types/interfaces).
- [ ] Add `failure_reason` to the select when loading **cold_dm_campaign_leads** (and to any types/interfaces).
- [ ] In the **Sent** (or activity) list: for `status === 'failed'`, show the failure reason using the label table above, in the same row/block as username, date, status.
- [ ] In the **Campaign leads** (or per‑campaign) view: for `status === 'failed'`, show the same failure reason in the same place as the rest of the lead/status info.
- [ ] If you want, add a tooltip or short help text using the descriptions above so users know what each reason means.

No new API or VPS changes are required; the VPS already writes `failure_reason` into these columns.
