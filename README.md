# Curevia

Hospital appointment booking. One Node.js process (Express API + React/Vite/Tailwind client, SQLite storage) with email,
Google Sheet and Slack automation through **viaSocket**, and an **AI agent** that chases stuck bookings.

- Times are stored in UTC and shown and emailed in India time (IST), e.g. `24 Oct 2026, 10:30 AM`.
- Hosted on Embarko (Node 20). Only `DATA_DIR` persists, so the SQLite file lives there.

---

## How each role uses the app

### Patient
1. **Browse** the home page, departments and doctor profiles (no account needed).
2. **Sign up** with email + password, then click the **verification link** in the email. Booking needs a verified email.
3. **Book** in 3 steps: choose doctor, pick a slot (week strip, Morning / Afternoon / Evening chips), enter details.
   The request is **pending** until the doctor confirms. Emails: request received, confirmed, reminders (24 h and 1 h before, confirmed visits only), cancelled, needs a new time.
4. **My appointments**: "My visit" card with countdown and live status, Add to calendar (.ics), checklist, history timeline.
   Cancel is allowed up to **1 hour before** the visit.
5. If the doctor cancels (and offers another slot), changes hours, takes leave or is deactivated, the appointment becomes **needs rebooking**: the patient gets an email with free slots and a link (`/my/rebook/<id>`) to pick one.
   A still-pending request can also be moved to a slot offered by the agent.
6. Forgot password: "Forgot your password?" on the sign-in page emails a 1-hour link.

### Doctor
1. The admin creates the profile. The doctor gets an email with a **set-your-password link** (48 hours, once). If email is not set up, the admin copies the link from the Doctors page.
2. **Today** shows today's appointments and pending requests with **Confirm** / **Cancel** (a reason is required; tick "Offer the patient another slot" to start rebooking, or untick for a final cancellation).
3. **Mark completed / No-show** works once the appointment time has started.
4. **Availability & leave**: weekly blocks (day, start, end, slot length) and leave dates. Before saving, Curevia shows how many booked appointments would no longer fit; those become **needs rebooking**.
5. A doctor only ever sees their own appointments.

### Admin
Signs in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` (the account is kept in sync with those variables on every start).
- **Dashboard**: cards (today, pending, confirmed, cancelled, needs rebooking), bookings per doctor, appointment list, **CSV download**.
- **Doctors**: create, edit, deactivate/activate. Deactivating signs the doctor out, hides them from booking and moves their upcoming appointments to needs rebooking.
- **Departments**: add, edit, hide.
- **Integrations**: set up the 3 viaSocket slots, send test messages (see below).
- **Agent activity**: open cases, every decision with its reason, and **Check now**.

---

## Appointment statuses
`pending` -> `confirmed` -> `completed` / `no_show`
`pending` / `confirmed` -> `cancelled_by_patient` / `cancelled_by_doctor` / `needs_rebooking` -> `rebooked`
(also `pending` -> `rebooked` when a patient moves a pending request to an offered slot, and `needs_rebooking` -> `cancelled_by_patient` if the patient declines).
A booking stays `pending` until the doctor confirms. A slot can never be double-booked: a unique database index plus an overlap check enforce it.
When a patient picks a new slot, the new appointment keeps the status the old one had (a confirmed one stays confirmed).

---

## viaSocket (Integrations page)

The admin sets up each slot once on **Admin -> Integrations** (needs `VIASOCKET_EMBED_SECRET`). Each slot is one flow built in viaSocket's own screen:

| Slot | App and action (ids read from the live catalog) | Curevia sends |
| --- | --- | --- |
| `appointments_sheet` | Google Sheets, **Add New Row to Sheet** (`rowxsuumuqrt`) | `appointment_id, patient_name, age, gender, phone, email, reason, doctor, department, date, time, status, event, at` (IST). One row per booking and per status change; `event` = booked / confirmed / cancelled_by_patient / cancelled_by_doctor / needs_rebooking / completed / no_show / rebooked. |
| `email_sender` | Gmail, **Send Email** (`rowogelpy0h6`) | `to, subject, body` (HTML). Curevia writes every email. |
| `slack_alert` | Slack, **Send Message** (`row1jrbor`) | `text`, to `#curevia-alerts`. Used for the agent's admin alerts. |

How it works:
- The embed token is an HS256 JWT (`org_id`, `project_id`, `unique_identifier`) signed on the server. The browser only gets the token.
- When the admin saves a flow, the page tells the server the flow id; the server **reads the flow's run address back from viaSocket**. Run addresses never reach the browser. An existing flow is reopened by id, so no extra drafts are created.
- Every send is recorded as **sent / failed / skipped** with a unique key per type per appointment, so nothing is sent twice. "Skipped" means the slot is not set up yet.
- viaSocket answers HTTP 200 even when a step inside a run fails, so Curevia **reads the reply body**: an `error`, `success: false`, error status or similar counts as **failed**. Failed emails and sheet rows are retried on later ticks (up to 5 tries in 24 hours).
- The Sheets "Update Spreadsheet Row" action exists in the catalog but is **not used**: the sheet is an append-only history, as in the brief.
- Gmail is identified by its catalog service id (`rowo0bqrhj5g`) because viaSocket's `serviceIdFor('gmail')` fails (a viaSocket catalog bug; the action id is verified).

## The 5-minute job and the AI agent

`embarko.json` schedules `/api/cron/tick` every 5 minutes. Embarko calls it with **GET**; the route also accepts **POST**. Both need `Authorization: Bearer <CRON_SECRET>` and answer **401** otherwise (always 401 if `CRON_SECRET` is not set).
A tick (safe to run twice, even at once) does three things: sends due reminders, retries failed sends, and runs the agent.

**Agent.** Open cases: (a) `pending` and not yet confirmed, (b) `needs_rebooking`. For each case the viaSocket AI API (server side only, `json_schema` answer, model `AGENT_SERVICE` / `AGENT_MODEL`) is given scheduling facts and the free slots found by our code, and chooses **one** action: `remind_doctor`, `alert_admin`, `offer_slots_to_patient` (up to 3 of the given slots, plus a short friendly note), `remind_patient`, `wait` (minutes), `close_case`.
The AI never sees patient names, phone numbers, emails or reasons for the visit, and never gives medical advice.

Our code checks every action before doing it:
- at most **2 doctor reminders** and **2 patient reminders**, an hour apart; slot offers are at least 2 hours apart (max 3 per case);
- **admin alert at most once** per case (Slack, no patient details);
- only slots from the free list it was given, up to 3, re-checked as free just before the email goes out;
- `close_case` only after the admin has been alerted;
- it **never books, confirms or cancels** for the patient (it has no way to);
- a case ends by itself when the appointment is confirmed, cancelled, moved or past.

Defaults it follows: remind the doctor after 2 h unconfirmed (again at 4 h), alert the admin after 6 h (a code safety rule alerts even if the AI keeps waiting), and if the appointment is under 12 h away and still pending, offer other slots in the same department.
If the AI call fails, returns something invalid, or its suggestion is refused, **fixed rules** with the same defaults decide, and the log says why. Every decision (including refused ones) is saved in `agent_log` and shown on **Agent activity**.

---

## Run it locally

```bash
cp .env.example .env      # edit the values
npm install
npm run build             # builds the React client into dist/
npm run seed              # FAKE demo data, local only (refuses when NODE_ENV=production)
npm start                 # http://localhost:3000
```
`npm run seed` adds 6 departments (General Medicine, Pediatrics, Cardiology, Orthopedics, Dermatology, ENT), 2 fake doctors each with availability, and one fake patient. Every fake login uses the password `demo-pass-123`: `patient@example.com`, `anita.rao@example.com`, and `<firstname>.<lastname>@example.com` for the other doctors. For client development run `npm run dev:server` and `npm run dev:client` in two terminals.

## Tests

```bash
npm test                          # everything, including viaSocket's check script (needs internet)
SKIP_VIASOCKET_CHECK=1 npm test   # offline
```
Tests use a **fake viaSocket and a fake AI** and cover: double booking blocked (also two at once), other roles' pages and APIs refused, reminders sent once, availability change creates needs_rebooking, the agent obeying every guardrail and falling back to fixed rules, and a run reply containing an error being treated as failed.
`npm run check:viasocket` runs viaSocket's own check script (invented ids, hand-built URLs, hard-coded secret). The build and tests were also run on a real Node 20.20.2 (what Embarko uses).

## Environment variables

| Variable | Needed | What it is |
| --- | --- | --- |
| `NODE_ENV` | production | Set to `production` on Embarko. |
| `APP_URL` | yes (production) | Public address, no trailing slash, e.g. `https://curevia-ankita.embarko.app`. Used in email links. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | yes | The admin account (password 8+ characters). |
| `SESSION_SECRET` | yes | Random string, 16+ characters, signs the login cookie. |
| `VIASOCKET_ORG_ID` | for viaSocket | `80141` |
| `VIASOCKET_PROJECT_ID` | for viaSocket | `projKcrymrh3` |
| `VIASOCKET_UNIQUE_ID` | optional | Default `curevia-hospital`. The one viaSocket user that owns all flows and AI threads. |
| `VIASOCKET_EMBED_SECRET` | for viaSocket | Signing secret (viaSocket -> Integrations -> the embed -> Install Code). Server only. |
| `AGENT_SERVICE`, `AGENT_MODEL` | optional | AI for the agent. Default `openai` / `gpt-5-mini`. |
| `TRUST_PROXY` | optional | Proxies in front of the app, default `1`. |
| `CRON_SECRET` | set by Embarko | Protects `/api/cron/tick`. |
| `PORT`, `DATA_DIR` | set by Embarko | Port to listen on (0.0.0.0) and the only persistent folder. |

If a required variable is missing the app stays up and serves a holding page (503, names only) until it is set and the app is restarted. Without the viaSocket variables the booking app works; emails, sheet rows and Slack alerts are simply skipped.
Secrets live only in environment variables; `.env` is git-ignored and never printed.

## Deploy to Embarko

Follows the HireDrive runbook. Embarko builds with `npm install`, `npm run build`, `npm run start` on **Node 20.20.2** (from `engines.node`), which is why `better-sqlite3` is `^12.11.1`.
Put the deploy token in `DEPLOY_TOKEN` (or line 1 of `~/.embarko/credentials`), commit, then:

```bash
DRY_RUN=1 scripts/embarko-deploy.sh curevia-ankita   # packs `git archive HEAD`, checks it, uploads nothing
scripts/embarko-deploy.sh curevia-ankita             # upload, wait for "live", print logs if it fails
```
Then add the variables above on the app's environment page and press **Apply changes** (restarts the app, no rebuild). `DATA_DIR` and variables survive redeploys. Data is **not backed up** by Embarko: use the CSV download for exports.

---

## Manual test list for the live site

Replace `SITE` with `https://curevia-ankita.embarko.app`. Use your own email addresses for the fake people. Start after all variables are applied.

**A. Basics and security**
1. Open `SITE/` -> the home page loads (it will look empty until you add departments and doctors).
2. `curl -i SITE/api/cron/tick` and `curl -i -X POST SITE/api/cron/tick` -> both **401**.
3. Signed out, open `SITE/admin` -> sent to the sign-in page. `SITE/doctor` and `SITE/my` likewise.

**B. Admin setup**
4. Sign in at `SITE/login` with the admin account -> Dashboard shows zeros.
5. **Departments**: add "General Medicine" and "Pediatrics".
6. **Integrations** (see section C first if you want emails right away).

**C. Integrations** (Admin -> Integrations; each card: *Set up*, build the flow in the embedded screen, *Publish*)
7. **Google Sheet**: pick a spreadsheet and tab, put the 14 column titles in row 1, map each column, publish. The card turns **Active**. Press **Send test** -> a row with `Test Patient (fake)` appears.
8. **Gmail**: connect the sending account, map To / Subject / Body, publish. **Send test** -> you receive "Curevia test email".
9. **Slack**: choose `#curevia-alerts`, map the text, publish. **Send test** -> message appears.
10. Close and reopen a card with **Edit flow** -> it reopens the same flow (no new draft). Check the card counts (sent / failed / skipped).
11. If anything looks different from this description (a card stays Draft after publishing, no events arrive, a test says failed), note the card and the message and tell me.

**D. Doctor**
12. **Doctors -> Add doctor** with an email you can read -> you get the "Set your Curevia password" email (or, if email failed, the page shows a link to copy). Open it, set a password, sign in at `/login` -> you land on the doctor dashboard.
13. Try `SITE/admin` as the doctor -> **403 page**.
14. **Availability & leave**: add Mon-Fri 09:00-13:00 with 15 min slots, save.

**E. Patient booking**
15. Sign up as a patient (another email) -> verification email -> click the link -> "email verified".
16. Browse to the doctor, pick a slot at least a few hours away, fill the form, **Request appointment** -> success screen. Check: patient "request received" email, doctor "new request" email, a `booked` row in the sheet, "My appointments" shows the countdown and status **Waiting for confirmation**.
17. In a second browser (or private window) sign in as another patient and try to book the **same slot** -> "slot was just taken".
18. As the patient try `SITE/admin` -> **403**.

**F. Doctor actions**
19. As the doctor, **Confirm** the request -> patient gets the "confirmed" email, sheet row `confirmed`, the patient's status flips to **Confirmed** within 30 seconds (or on refresh).
20. Patient: **Add to calendar** downloads a `.ics`. Try **Cancel appointment** -> a dialog asks "Are you sure?".

**G. Reminders**
21. Confirm an appointment that starts in **about 25-26 hours**. When it is under 24 hours away press **Admin -> Agent activity -> Check now** (or wait for the 5-minute job) -> the patient gets "your appointment is tomorrow" **once**; pressing Check now again sends nothing more. Same for the 1-hour reminder (the visit must have been confirmed more than an hour before it starts).

**H. Needs rebooking and the agent**
22. Create a second doctor in the same department with availability. Book and confirm a visit with the first doctor, then as that doctor open it and **Cancel** with a reason and "Offer the patient another slot" ticked -> patient gets a "choose a new time" email with options and a link, sheet row `needs_rebooking`.
23. **Check now** on Agent activity -> a decision appears with its reason (offered slots, or waiting). Open the link as the patient, pick a slot -> the new appointment keeps the old status; the old one shows **rebooked**.
24. Leave a request **pending** for 2+ hours -> **Check now** -> the doctor gets a reminder. At 6+ hours the admin gets a Slack alert, once only.
25. Change availability so an existing appointment no longer fits (the doctor sees the warning first) -> it becomes needs rebooking.
26. **Deactivate** a doctor with an upcoming appointment -> it becomes needs rebooking; the doctor can no longer sign in.

**I. Admin reporting**
27. Dashboard cards and the per-doctor table match what you did. **Download CSV** opens in a spreadsheet.
28. After everything, check the Google Sheet has one row per booking and status change, and the Integrations cards show no unexpected failures.

---

## Decisions and limits worth knowing
- Doctors can mark completed / no-show only once the appointment has started.
- Patients can cancel a `needs_rebooking` appointment at any time.
- Email addresses and fake data in `seed` are fake; the footer address and phone are demo placeholders (`client/src/config/content.js`).
- Health tips and visit checklists are static text in `client/src/config/content.js` (not AI, not medical advice).
- Embarko has no WebSockets and 256 MB RAM; the live status badge refreshes by polling every 30 seconds.
- Tailwind 3 (build-time) has npm audit notices in its build toolchain; they do not run in the server.
