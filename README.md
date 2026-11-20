# Dental AI Receptionist (Plivo + Pipecat)

A 24/7 AI receptionist for US dental clinics. It answers calls, books, reschedules and cancels
appointments, captures sales inquiries, texts reminders, calls no-show patients to rebook, calls
patients after their visit for feedback, and sends the clinic a daily report on their phone.

Built by Deific Digital. Multi-clinic: one deployment serves many clinics, each with its own Plivo number.

```
 Patient phone ──► Plivo number ──► voice/  (Python, Pipecat)
                                     Deepgram STT → OpenAI LLM (+tools) → Deepgram TTS
                                          │  tool calls (X-Internal-Key)
                                          ▼
 Clinic web admin (web/, Next.js) ──► api/  (Node.js, Express, PostgreSQL) ◄── mobile/ (Expo React Native)
                                          │
                     jobs: reminders, no-show calls, feedback, daily report, data purge
                                          │
                                   Plivo SMS + webhooks
```

## What's in each folder

| Folder | What it is |
|---|---|
| `api/` | Node.js + TypeScript API, PostgreSQL (Drizzle ORM), background jobs, Plivo SMS, audit log, 2FA |
| `voice/` | Python voice agent: Plivo audio stream → Pipecat pipeline, inbound reception + outbound no-show / feedback calls, live transfer |
| `web/` | Next.js web admin: clinic dashboard + Deific super admin (all clinics) |
| `mobile/` | Expo React Native clinic app: today's appointments (Came / No-show), daily report, CRM follow-ups, push alerts |
| `extras/` | Clickable HTML sales demo + 3.5-minute walkthrough video to show clinics |

**Deploying? Follow [DEPLOY.md](DEPLOY.md) step by step.**

## Features

**AI receptionist (calls)**
- Answers every call 24/7 with the clinic's greeting, hours, services, insurance and pricing info
- Books into the built-in calendar (per-dentist availability, no double booking)
- Existing patients: find, reschedule, cancel, confirm (after a first-name identity check)
- Captures sales inquiries (prices, Invisalign, insurance…) as leads with an instant alert
- Live transfer to the front desk; 911 guidance for real emergencies
- Call summary + encrypted transcript saved for every call

**Follow-ups**
- Booking confirmation text + reminder text (Reply C to confirm, R to reschedule, STOP to opt out)
- No-show → AI calls the patient to rebook (inside calling hours, with retries)
- Came → AI calls (or texts) for a 1–5 rating and comment; low scores alert the owner
- Optional auto-mark no-show if staff forget

**CRM (built in)**
- Every AI inquiry becomes a CRM contact with a call-back task; new patients booked by the AI are added too
- Pipeline board (drag & drop): New inquiry → Contacted → Appointment booked → Treatment plan sent → Won / Lost
- Deal value, owner, source, tags; win rate and revenue won this month
- Contact timeline (AI calls, texts, notes, stage changes, tasks) — notes are encrypted
- Follow-up tasks with due dates, overdue alerts and a morning "follow-ups due today" push
- Mobile: call back with one tap, mark booked, tick off tasks

**Filters on every list**
- Appointments (search, status incl. "not marked", dentist, booked by AI/staff), patients (new/existing, consent, upcoming visit),
  calls (date, direction, purpose, result, search), feedback (rating, channel, search), notifications (type, unread),
  CRM (search, source, owner, tag, stage), tasks (due today, overdue, owner, type), audit log (who, action), daily report (dentist)

**Clinic dashboard & app**
- Today's appointments with one-tap Came / No-show
- Daily report pushed every evening: who came, who didn't, AI bookings, calls, inquiries, rating
- Patients, calls (summary + transcript), inquiries, feedback, notifications
- Settings: hours, services, dentists, AI knowledge, follow-up rules, team, 2FA, audit log
- Super admin: create clinics, see calls/minutes/AI bookings per clinic (for billing)

## HIPAA — what the code does and what you must still do

The software is built for HIPAA, but **HIPAA compliance comes from the whole setup, not the code alone.**

Built in:
- Encryption in transit (HTTPS/TLS, `DATABASE_SSL`) and AES-256-GCM encryption of transcripts, summaries, notes, feedback and SMS bodies
- Login with bcrypt passwords, optional TOTP 2FA, 15-minute access tokens with rotating refresh tokens
- Auto logoff: web after 15 min idle; mobile after 15 min in the background
- Role-based access (super admin / owner / staff) and per-clinic data isolation
- Audit log of logins and every view/change of patient records (Settings → Audit log)
- Minimum necessary: push notifications and in-app alerts never contain names or health details; SMS text only has clinic name + time
- AI can only touch appointments belonging to the caller's phone number, and only after the caller gives the first name on file
- Automatic deletion of transcripts and SMS after the retention period (default 90 days)
- Deepgram `mip_opt_out` (no training on call audio); voice agent logs at INFO (no transcripts in logs)
- Consent tracking: SMS consent, call consent, STOP/START handling; outbound calls only inside calling hours

You must do (see the HIPAA checklist sheet):
1. **Sign BAAs** with every vendor that touches PHI: Plivo (Enterprise), Deepgram, OpenAI (zero/modified retention) or Azure OpenAI, your cloud host (AWS/GCP/Azure), and with each clinic.
2. Host on HIPAA-eligible services (e.g. AWS RDS encrypted + ECS/EC2) — not a regular VPS without a BAA.
3. Register for **A2P 10DLC** (or toll-free verification) before sending SMS from US numbers.
4. Turn on 2FA for every user, change the seed passwords, keep `ENCRYPTION_KEY` in a secrets manager and back it up.
5. Security risk assessment, written policies, staff training, breach plan — and a review by a US healthcare compliance lawyer before go-live.

## Run it locally

Requirements: Node 20+, Python 3.11+, PostgreSQL 16 (or Docker).

```bash
# 1) Database
createdb dental   # or: docker compose up -d db

# 2) API
cd api
cp .env.example .env        # set DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, INTERNAL_API_KEY
npm install
npm run db:migrate
npm run seed                # super admin + demo clinic (prints logins)
npm run dev                 # http://localhost:4000

# 3) Web admin
cd ../web
cp .env.example .env.local  # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install && npm run dev  # http://localhost:3000

# 4) Voice agent
cd ../voice
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # Plivo, Deepgram, OpenAI keys; PUBLIC_URL = your ngrok https URL
python server.py            # :7860   (ngrok http 7860)

# 5) Mobile app
cd ../mobile
npm install
# set "extra.apiUrl" in app.json to your API URL (your computer's LAN IP for a phone)
npx expo start
```

Without Plivo keys the API runs in **dry-run mode**: SMS and outbound calls are logged, not sent.

Demo logins after `npm run seed`: `admin@deificdigital.com` / `ChangeMe-Admin-2026` (super admin) and
`owner@demo-dental.com` / `ChangeMe-Owner-2026` (clinic owner). Change them immediately.

### Tests

```bash
cd api && JOBS_ENABLED=false npm test          # 15 end-to-end API tests against Postgres (incl. CRM + filters)
cd voice && INTERNAL_API_KEY=... python -m tests.test_contract   # voice agent ↔ API contract (API running)
```

## Going live with a clinic

1. **Super admin → Add clinic**: name, Plivo number, time zone, transfer number, owner login.
2. **Plivo console**: create an Application with
   - Answer URL `https://VOICE_HOST/plivo/answer` (POST)
   - Hangup URL `https://VOICE_HOST/plivo/hangup` (POST)
   - Message URL `https://API_HOST/webhooks/plivo/sms` (POST)

   and attach the clinic's number to it.
3. Clinic owner signs in → **Settings**: hours, services, dentists, "What the AI should know", follow-up rules. Turn on 2FA.
4. Install the mobile app (EAS build), sign in, allow notifications.
5. Ask the clinic to add "I agree to receive appointment calls and texts" to their patient intake form (TCPA consent).
6. Test-call the number, book, cancel, ask about insurance, ask for a person.

## Deploying

`docker-compose.yml` runs Postgres, API, voice agent and web on one server — good for staging.
For production with real patients: managed encrypted Postgres, HTTPS everywhere, secrets in a
secrets manager, all on a cloud account covered by a BAA. Run **one** voice-agent process per
instance (call state between the answer webhook and the media stream is in memory) or use sticky routing.

Mobile: `npx eas-cli init` (sets `extra.eas.projectId` for push), then `npx eas-cli build -p android|ios`.

## Running costs (rough, per clinic)

Per minute of AI conversation ≈ $0.04–0.07 (Plivo inbound ~$0.0055 + Deepgram STT/TTS + OpenAI).
Plus a Plivo number (~$0.50/month), SMS, hosting, and the BAA-tier plans of each vendor (Plivo
Enterprise etc.), which are usually the biggest fixed cost. The super admin page shows minutes per
clinic per month for billing.

## Configuration notes

- **TTS voice**: `DEEPGRAM_VOICE` (default `aura-2-thalia-en`) or `TTS_PROVIDER=cartesia`.
- **LLM**: `OPENAI_MODEL` (default `gpt-4o-mini`); point `OPENAI_BASE_URL` at Azure OpenAI if you prefer Microsoft's BAA.
- **Prompts**: `voice/prompts.py` (reception, no-show, feedback).
- **Tools the AI can use**: `voice/tools.py` → `api/src/routes/internal.ts`.
- **Jobs**: `api/src/jobs/index.ts` (every minute: reminders, outbound dispatch, daily report; every 5 min: auto no-show; nightly: purge).

## Not included yet (good next steps)

- Practice-management sync (Open Dental / Dentrix / Eaglesoft)
- Two-way SMS inbox in the dashboard
- CRM email sending (activities can be logged, but emails are sent from your own mailbox)
- Call recording audio storage (only transcripts are stored)
- Spanish-language calls
- Billing / Stripe for clinic subscriptions
