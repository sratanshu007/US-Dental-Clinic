# AWS production setup (HIPAA-eligible)

This moves the system off Hostinger onto AWS, which signs a BAA. Budget: about $60–90/month for the
first 10–20 clinics (EC2 t3.medium + RDS db.t4g.small + S3 + CloudWatch).

Everything below is done once. Use region **us-east-1** (or us-east-2) so calls stay low-latency for US clinics.

## 1. Account and BAA (30 minutes)

1. Create an AWS account for Deific Digital (business email, company card). Turn on MFA for the root user,
   then create an IAM user or IAM Identity Center user for daily work. Never use root again.
2. **Sign the BAA:** AWS Console → search **Artifact** → **Agreements** → **AWS Business Associate Addendum** →
   accept for the account. Download the PDF and keep it with your other BAAs.
3. Only use HIPAA-eligible services for patient data. This setup uses EC2, RDS, S3, KMS and CloudWatch Logs,
   which are on AWS's HIPAA-eligible list.

## 2. Network (15 minutes)

1. VPC → **Create VPC** → "VPC and more": 2 Availability Zones, 2 public + 2 private subnets, 1 NAT gateway
   (or none, if you put EC2 in a public subnet; see below).
2. Security groups:
   - `app-sg` (EC2): inbound 80 and 443 from anywhere; SSH 22 **only from your office IP** (or none, and use
     Systems Manager Session Manager instead).
   - `db-sg` (RDS): inbound 5432 **only from `app-sg`**.

## 3. Encryption key and backup bucket (10 minutes)

1. KMS → **Create key** → symmetric → alias `dental-ai-backups`.
2. S3 → **Create bucket** `dental-ai-backups-<random>` in the same region:
   - Block all public access: on.
   - Default encryption: SSE-KMS with `dental-ai-backups`.
   - Versioning: on. Lifecycle rule: delete objects after 35 days.

## 4. Database (20 minutes)

RDS → **Create database**:
- Engine PostgreSQL 16, template Production (or Dev/Test to save cost at the start).
- Instance `db.t4g.small`, storage 20 GB gp3, storage autoscaling on.
- **Encryption: on** (default KMS key is fine).
- Private subnets, no public access, security group `db-sg`.
- Automated backups: 14 days. Deletion protection: on.
- Parameter group: set `rds.force_ssl = 1`.

Copy the endpoint. In `api/.env`:
```
DATABASE_URL=postgresql://dental:<password>@<endpoint>:5432/dental
DATABASE_SSL=true
```
If Node complains about the certificate, download the RDS CA bundle and set `NODE_EXTRA_CA_CERTS=/path/global-bundle.pem`.

## 5. Server (20 minutes)

1. EC2 → **Launch instance**: Amazon Linux 2023, `t3.medium`, 30 GB gp3 **encrypted**, subnet public,
   security group `app-sg`, IAM role with:
   - `CloudWatchLogsFullAccess` (or a narrower policy for log group `/dental-ai/app`)
   - S3 put/get on the backup bucket and `kms:GenerateDataKey`/`kms:Decrypt` on the backup key
   - `AmazonSSMManagedInstanceCore` (Session Manager, no SSH needed)
2. Allocate an **Elastic IP** and attach it.
3. Connect and run `deploy/aws/setup-ec2.sh`.

## 6. App (20 minutes)

1. Copy the project to `~/dental-ai-receptionist` on the server.
2. Fill `api/.env` (from `api/.env.example`) and `voice/.env` (from `voice/.env.example`):
   - New random secrets: `openssl rand -hex 32` for JWT_SECRET, ENCRYPTION_KEY, INTERNAL_API_KEY.
     If you are moving from Hostinger, **reuse the old ENCRYPTION_KEY**, or old encrypted data can't be read.
   - Deepgram key (BAA signed), LLM key (BAA + zero data retention), Plivo keys.
   - `ALERT_WEBHOOK_URL`: a Slack or Discord channel webhook.
3. Fill `deploy/aws/.env` (domains, bucket).
4. DNS: point `api.`, `app.`, `voice.` and your link domain (e.g. `dd-care.com`) at the Elastic IP.
5. Start:
   ```
   cd ~/dental-ai-receptionist/deploy/aws
   docker compose --env-file .env -f docker-compose.prod.yml up -d --build
   ```
   The API applies database migrations on start. Check `https://api.<domain>/ready` shows `"db":"ok"`.

## 7. Moving data from Hostinger (only if you already have clinics there)

```
# on the old server
pg_dump --format=custom --no-owner "$OLD_DATABASE_URL" > dental.dump
# copy dental.dump to the EC2 server, then
pg_restore --no-owner --dbname="$DATABASE_URL" dental.dump
```
Keep the same ENCRYPTION_KEY. Then change Plivo answer URLs to `https://voice.<domain>/plivo/answer` and
delete the database and dumps from Hostinger.

## 8. Backups and restore test

1. `crontab -e` and add:
   ```
   15 4 * * * /home/ec2-user/dental-ai-receptionist/deploy/aws/backup.sh >> /home/ec2-user/backup.log 2>&1
   ```
2. Run it once by hand and check the file is in S3.
3. **Test a restore every 3 months** into a new temporary RDS instance with `deploy/aws/restore.sh`, then delete
   that instance. Write the date in your HIPAA log.

## 9. Monitoring

- **Uptime:** create two monitors (UptimeRobot, Better Stack or CloudWatch Synthetics), every 1 minute, alert by
  SMS/email to you: `https://api.<domain>/ready` and `https://voice.<domain>/ready`. These URLs return no patient data.
- **Alerts channel:** `ALERT_WEBHOOK_URL` receives job failures, 500 errors, crashes, failed backups and failed payments.
- **Logs:** container logs go to CloudWatch Logs group `/dental-ai/app`. Set retention to 30 days.
  Logs mask phone numbers and never contain transcripts.
- **Billing alarm:** AWS Budgets → monthly budget $150 with email alert.

## 10. Before the first real clinic

- [ ] BAAs signed: AWS, Deepgram, LLM provider (and Plivo only if your attorney says it's needed)
- [ ] `/ready` green on api and voice; uptime monitors alerting your phone
- [ ] Backup ran and a restore was tested
- [ ] Load test: `npx tsx scripts/loadtest.ts 20` against a test clinic, p95 under 800 ms
- [ ] 10 test calls from the Go-Live Checklist pass
- [ ] Hostinger copy deleted
