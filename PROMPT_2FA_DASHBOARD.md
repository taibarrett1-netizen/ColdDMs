# Prompt: Add 2FA popup to Cold Outreach Connect (dashboard)

Give this to your dashboard/frontend (e.g. Lovable or other app) so they can add the 2FA flow to the **Connect Instagram** screen.

---

**Backend is already done.** When the user clicks **Connect** with Instagram username and password, the API can now return “2FA required” and accept a second request with the 6-digit code. Implement the following on the **dashboard** (Cold Outreach → Connect tab).

---

## API contract

- **Endpoint:** `POST /api/instagram/connect`
- **Body:** `{ username, password, clientId }` (all required when Supabase is used). Optionally `twoFactorCode` (6-digit string) on the second request.

**Responses:**

1. **Success:** `{ ok: true }`  
   → Show success message, then clear the password and any 2FA code from the form (do not store them). Optionally clear the 2FA modal if it was open.

2. **2FA required:** `{ ok: false, code: "two_factor_required", message: "…" }`  
   → Do **not** show a generic error. Instead:
   - Keep the same `username`, `password`, and `clientId` in memory for the next request (do not re-display the password in the UI).
   - Show a **popup/modal** titled something like **“Two-factor code required”** with:
     - Short text: e.g. “Enter the 6-digit code from your authenticator app or WhatsApp.”
     - A single input: 6-digit security code (numeric, max length 6).
     - Buttons: **Submit** and **Cancel**.
   - When the user clicks **Submit**: call `POST /api/instagram/connect` again with the **same** `username`, `password`, and `clientId`, plus `twoFactorCode` set to the value from the input (digits only, e.g. strip non-digits and take first 6).
   - If that second response is `{ ok: true }`: close the modal, show success, and clear password and code from the form like in (1).
   - If the second response is an error: show the error message (e.g. “Code may be wrong or expired. Try again.”) and leave the modal open so they can enter a new code or cancel.
   - **Cancel** closes the modal and discards the pending 2FA step (user can try Connect again from scratch).

3. **Other errors:** `{ ok: false, error: "…" }` or HTTP 4xx/5xx  
   → Show the `error` (or a generic “Login failed”) in the usual way on the Connect form; no 2FA modal.

---

## UX summary

- First tap **Connect** → if 2FA is required, show the popup and ask for the 6-digit code; do not show a generic “login failed” for `two_factor_required`.
- User enters code from WhatsApp or authenticator app → **Submit** → same API with `twoFactorCode`; on success, register the connection and clear password and code like normal.
- After a successful connect (with or without 2FA), never store the password or the 2FA code; only clear the fields and close the modal.

Use this so the dashboard registers 2FA, shows the popup to enter the code, then completes the connection and deletes password and code as usual.
