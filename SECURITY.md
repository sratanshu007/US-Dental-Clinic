# Security

No software can promise it will never be hacked. What this system does is make attacks hard, limit the
damage if one part is breached, and tell you quickly when something looks wrong. This page lists every
control, how it's tested, and what you still have to do yourself.

## 1. Logins and sessions

| Control | Detail |
| --- | --- |
| Passwords | bcrypt (cost 12). New passwords: 12+ characters, common/breached-style passwords refused, can't contain your email or name, can't reuse the current one |
| Account lockout | 5 wrong passwords → locked 15 minutes, audit entry + alert. Locked accounts get the same message as a wrong password |
| No email enumeration | Unknown email and wrong password take the same time and return the same message (dummy bcrypt compare) |
| Two-factor login (TOTP) | Required for super admins in production (`REQUIRE_ADMIN_MFA`). Turning 2FA on needs the password; turning it off needs the password **and** a code — a stolen session can't remove it |
| Access tokens | 15-minute JWTs, HS256 pinned, issuer + audience checked. Role and clinic are re-read from the database on every request, so a tampered token can't grant admin |
| Instant revocation | Password change, disabling a user, changing a role, turning off 2FA or "Sign out on all devices" bumps a per-user token version: every existing token stops working within seconds |
| Refresh tokens | Random 256-bit, stored only as SHA-256, rotated on every use. Re-use of an old refresh token (a copied token) signs that user out everywhere and alerts you |
| Idle logout | Dashboard and app sign out after 15 minutes of inactivity |
| Token storage | Web: sessionStorage (cleared when the tab closes), never localStorage. Phone: iOS Keychain / Android Keystore (expo-secure-store) |

## 2. API

- Every clinic route is scoped to the signed-in user's clinic; clinic users can't read other clinics (tested).
- Input validated with zod on every route; database access through Drizzle (parameterized — no SQL string building).
- Rate limits: login 20 / 15 min per IP, API 600 / min per IP, patient links 30 verify attempts / 15 min.
- Helmet security headers, HSTS (2 years, preload), `Cache-Control: no-store` on every API response, no `X-Powered-By`.
- CORS: only the dashboard origin(s) in `CORS_ORIGINS`.
- Errors never return internal messages or stack traces; 500s alert the ops channel with phone numbers/emails scrubbed.
- **Production start-up guard** refuses to boot with weak or reused secrets, placeholder values, non-https CORS/API URLs,
  a remote database without TLS, Plivo signature checks off, or dry-run mode on.

## 3. Webhooks and service-to-service

| Endpoint | Protection |
| --- | --- |
| Plivo webhooks (API + voice) | Plivo signature V3 checked on every request, constant-time compare. Implemented in-house (the Plivo SDK was removed: its dependencies had critical advisories); verified against the official SDK with test vectors |
| Plivo media stream (WebSocket) | Only accepted for a call Plivo just announced, carrying that call's one-time random token |
| Stripe webhook | Stripe signature checked on the raw body |
| `/internal/*` (voice → API) | Shared 32+ character key, constant-time compare, optional IP allow-list (`INTERNAL_ALLOWED_IPS`), and **blocked at the public proxy** (Caddy returns 404) |
| `/outbound/*` (API → voice) | Same internal key; blocked at the public proxy |

## 4. Patient data

- TLS everywhere; database encrypted at rest (RDS); transcripts, summaries, notes, SMS bodies, DOB, insurance and
  2FA secrets additionally encrypted per field with AES-256-GCM.
- DOB is matched by HMAC (separate derived key), never stored in plain text.
- Callers must pass a name + date-of-birth check before the AI reveals or changes an appointment; 3 misses lock the call.
- Texts carry only the clinic name and a secure link (check question, 5-try lock, short expiry).
- Push notifications contain no patient names.
- Logs never contain what callers say, names or phone numbers (masked).
- Retention purge deletes transcripts and message bodies after the clinic's retention period.
- Audit log of sign-ins, failed logins, lockouts, every patient record view/change, settings and billing changes.
- AI prompt rule: the assistant ignores callers who try to change its rules or extract its instructions; it can only act
  through the tool API, which enforces identity checks server-side (the model can't skip them).

## 5. Infrastructure (deploy/aws)

- Only Caddy (ports 80/443) is exposed; API, voice and dashboard run on a private Docker network.
- Containers run as a non-root user, `no-new-privileges`, all Linux capabilities dropped, read-only root filesystem
  (API and voice), healthchecks, tini as PID 1.
- Database in private subnets, reachable only from the app security group; TLS enforced (`rds.force_ssl`).
- Nightly encrypted (KMS) backups to a private, versioned S3 bucket; quarterly restore test.
- Automatic OS security updates on the server.
- Dependencies: `npm audit --omit=dev` shows 0 known vulnerabilities in the API, voice agent and dashboard.
  The mobile app has 3 moderate advisories in Expo's build tooling (minimatch, used at build time only, not in the app);
  update Expo when a patched release is out.

## 6. Tests

`api/test/security.test.ts` checks: security headers, forged/`alg:none`/wrong-secret/no-audience tokens rejected,
role escalation via token refused, lockout + no enumeration, instant revocation on password change, refresh-token
theft detection, 2FA re-authentication, password policy, production config guard, internal key, cross-clinic access.
`voice/test/e2e.test.ts` checks unsigned webhooks, forged media-stream tokens and missing internal key are refused.

## 7. What you must do (outside the code)

1. Generate fresh secrets for production (`openssl rand -hex 32`, three different values) and keep them in a secrets manager.
2. Turn on MFA for your AWS root and IAM users, Plivo, Deepgram, LLM provider, Stripe, GitHub and your email.
3. Turn on 2FA for your own super-admin login before going live (admin pages are blocked until you do).
4. AWS: enable GuardDuty and CloudTrail; put the domains behind Cloudflare (or AWS WAF) for DDoS protection and bot filtering.
5. Get an independent penetration test before the first large clinic or DSO (they will ask for it), and once a year.
6. Run `npm audit` monthly and update dependencies; subscribe to GitHub Dependabot alerts.
7. Follow the incident response steps in the Launch Readiness doc if anything looks wrong.

## Reporting a problem

Email hello@deificdigital.com with "SECURITY" in the subject. Please don't test against live clinic data.
