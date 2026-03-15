# Dashboard: Campaign status "Active" vs "Stopped"

**Why "No work" when there are pending leads?**

The bot only processes campaigns whose **status** is **`active`** (in `cold_dm_campaigns.status`). If a campaign is **Stopped**, **Paused**, or **Completed**, the bot will report "No work" even if the campaign has pending leads.

- **"Status: Stopped"** on the campaign = `cold_dm_campaigns.status` is not `'active'` (e.g. `stopped`, `paused`, `completed`). The bot ignores it.
- **"Status: active"** under Lead groups = lead group or message stats, not the campaign run state.

**What to do in the dashboard**

1. **Show campaign status clearly**  
   On the campaign detail (e.g. Information or Settings tab), show the **campaign’s** status from `cold_dm_campaigns.status` (e.g. "Active", "Stopped", "Paused", "Completed") and make it obvious that **only Active campaigns are sent**.

2. **Let the user set the campaign to Active**  
   Provide a control (e.g. in Settings or campaign header) to set `cold_dm_campaigns.status` to **`active`** so the bot will pick it up when the user clicks Start. If the campaign was previously "Stopped" or "Completed", they must set it back to "Active" before the next run.

3. **Optional: Start = unpause + activate**  
   When the user clicks "Start", you can optionally set all campaigns that have pending leads to `status = 'active'` for that client (or only the one they’re viewing), so they don’t have to toggle status separately. Current behaviour is: Start only sets `cold_dm_control.pause = 0`; it does not change campaign status.

**VPS log**

When there’s no work, the bot now logs a hint if campaigns have pending leads but aren’t active, e.g.:

`No work: Campaign(s) have pending leads but status is not active: "Testing GHL" (stopped). Set campaign to Active in the dashboard.`

Use that message in the dashboard (e.g. tooltip or help text) so users know they must set the campaign to Active to send.
