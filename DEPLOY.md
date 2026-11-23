# Deploy guide — step by step

This takes the code from the zip to a live system: API + voice agent + web admin on a server,
the mobile app in the stores, and a Plivo number answering calls.

> **Before real patient calls:** sign BAAs with Deepgram, your LLM provider (OpenAI / xAI ZDR), your TTS provider
> and your cloud host, and host on HIPAA-eligible services. For Plivo either sign its Enterprise BAA or use
> transport-only mode (section 6) after your attorney confirms it. Until then use test numbers and fake data.

## 0. What you need

| Item | Notes |
|---|---|
| A Linux server | Ubuntu 22.04+, 2 vCPU / 4 GB RAM is enough for a few clinics. For HIPAA: AWS EC2/ECS under the AWS BAA |
| PostgreSQL 16 | Managed and encrypted (AWS RDS) for production; the docker-compose `db` service is fine for staging |
| 3 domains | `api.yourdomain.com`, `voice.yourdomain.com`, `app.yourdomain.com` (HTTPS required) |
| 1 short link domain | e.g. `dd-care.com` — for secure patient links in texts (don't use bit.ly-style shorteners) |
| Plivo account | One US number per clinic |
| Deepgram + OpenAI keys | Speech-to-text / voice and the AI brain |
| Expo account | To build the mobile app (free tier works) |

## 1. Server + code

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin caddy
git clone <your repo> dental-ai && cd dental-ai      # or unzip the delivered zip
```

## 2. Environment files

```bash
cp api/.env.example api/.env
cp voice/.env.example voice/.env
```

Generate secrets (run three times, use a different value for each):

```bash
openssl rand -hex 32
```

`api/.env` — set at least:

```
JWT_SECRET=<random>
ENCRYPTION_KEY=<random, 64 hex chars — BACK THIS UP, losing it makes transcripts/notes unreadable>
INTERNAL_API_KEY=<random — same value in voice/.env>
PUBLIC_API_URL=https://api.yourdomain.com
PATIENT_LINK_BASE=https://dd-care.com
CORS_ORIGINS=https://app.yourdomain.com
PLIVO_AUTH_ID=...
PLIVO_AUTH_TOKEN=...
DATABASE_URL=postgresql://dental:<password>@db:5432/dental   # or your RDS URL + DATABASE_SSL=true
```

`voice/.env` — set:

```
PUBLIC_URL=https://voice.yourdomain.com
INTERNAL_API_KEY=<same as api>
PLIVO_AUTH_ID=... / PLIVO_AUTH_TOKEN=...
DEEPGRAM_API_KEY=...
OPENAI_API_KEY=...
```

## 3. Start everything

```bash
export DB_PASSWORD=<strong password>
export NEXT_PUBLIC_API_URL=https://api.yourdomain.com
docker compose up -d --build
curl -s localhost:4000/health                   # {"ok":true}
docker compose exec api node dist/seed.js       # optional: super admin + demo clinic (prints logins)
```

The API container runs database migrations automatically on start.

## 4. HTTPS (Caddy)

`/etc/caddy/Caddyfile`:

```
api.yourdomain.com   { reverse_proxy localhost:4000 }
voice.yourdomain.com { reverse_proxy localhost:7860 }
app.yourdomain.com   { reverse_proxy localhost:3000 }
dd-care.com          { reverse_proxy localhost:4000 }
```

```bash
sudo systemctl reload caddy
```

Caddy gets certificates automatically. Point the DNS A records (all four domains) at the server first.

## 5. First login

1. Open `https://app.yourdomain.com`, sign in as the super admin (seed prints the login) — **change the password and turn on 2FA** (Settings → Security).
2. **All clinics → Add clinic**: clinic name, the Plivo number, time zone, staff transfer number, owner login.
3. Sign in as the clinic owner → Settings: hours, services, dentists, "What the AI should know", follow-up rules. Turn on 2FA.

## 6. Plivo

1. Buy a US local number for the clinic.
2. Voice → Applications → **New application**:
   - Answer URL: `https://voice.yourdomain.com/plivo/answer` (POST)
   - Hangup URL: `https://voice.yourdomain.com/plivo/hangup` (POST)
   - Message URL: `https://api.yourdomain.com/webhooks/plivo/sms` (POST)
3. Attach the number to the application.
4. Register the brand + campaign for **A2P 10DLC** (required for SMS from US local numbers).
5. Call the number. You should hear the greeting, and the call shows up in **Calls** with a summary.

### Secure link texts (default)

Each clinic has **Settings → Follow-ups & texts → What the text contains**:

- **Secure link only** (default, recommended): texts say e.g. *"Demo Family Dental: you have an upcoming appointment.
  View details: https://dd-care.com/p/x7K9… Reply C to confirm or R to reschedule."* The day, time, dentist and
  visit type are shown only on the link page, after the patient types their last name (first name, or the last
  4 digits of their phone, if we don't have a last name).
- **Day and time in the text**: the old style.

Link rules: random 24-character token (only its hash is stored), expires after 72 hours or 6 hours after the visit,
locks after 5 wrong answers, 15-minute session after a correct answer, no-store/noindex/no-referrer headers,
every open/check/confirm/reschedule is in the audit log. On the page the patient can confirm, ask for a new time
(creates a CRM call-back task + alert), or call the office. Test it: book a test appointment for your own phone
number and open the link from the text.

### Transport-only mode (keep patient data out of Plivo's storage)

Use these settings so Plivo only carries calls and texts and does not keep their content:

1. **Inbound SMS:** open the application → turn on **Redact Incoming Messages** (API: `log_incoming_messages=false`).
   Our webhook still receives the text; Plivo just does not keep it.
2. **Outbound SMS:** nothing to do — the API sends every text with `log=false` (`PLIVO_REDACT_SMS=true`, the default).
3. **Calls:** do not turn on Plivo call recording, transcription or Plivo AI features. The audio is streamed
   to our voice server, and transcripts are stored encrypted on our side only.
4. **Support tickets:** never paste patient names, numbers or message text into Plivo support.

Whether this lets you use Plivo without a BAA (the HIPAA "conduit exception") is a legal decision — confirm it
with a US healthcare attorney and note it in your HIPAA risk assessment before real patient calls.

## 7. Mobile app

```bash
cd mobile
npm install
npx eas-cli login
npx eas-cli init                       # writes extra.eas.projectId into app.json (needed for push)
```

In `app.json` set `extra.apiUrl` to `https://api.yourdomain.com`, and change `ios.bundleIdentifier` /
`android.package` if you publish under another company name. Then:

```bash
npx eas-cli build -p android --profile production
npx eas-cli build -p ios --profile production
npx eas-cli submit -p android    # / -p ios
```

For quick testing on your own phone: `npx eas-cli build -p android --profile preview` and install the APK.

## 8. Check before go-live

- [ ] Test call: book, reschedule (give first name), cancel, ask about insurance, ask for a person (transfer)
- [ ] An inquiry call creates a CRM contact + call-back task
- [ ] Mark a past appointment No-show → outbound AI call happens inside calling hours
- [ ] Reminder text arrives; replying C confirms, STOP opts out
- [ ] Push notification arrives on the phone; no patient names in it
- [ ] Daily report push at the report time; morning CRM follow-up push
- [ ] All BAAs signed; database encrypted; backups on; ENCRYPTION_KEY stored in a password manager / secrets manager
- [ ] Seed/demo accounts and the demo clinic deleted or passwords changed

## Updating

```bash
git pull   # or copy the new code
docker compose up -d --build     # migrations run automatically
```

## Backups

- Database: enable automated snapshots (RDS) or `pg_dump` nightly to encrypted storage.
- `ENCRYPTION_KEY` and `.env` files: keep a copy in a secrets manager. Without the key, encrypted fields can't be read.
