// Loaded first by v3.test.ts so config picks these up. Mock Open Dental runs on this port.
process.env.OPEN_DENTAL_API_URL = "http://127.0.0.1:47811/api/v1";
process.env.OPEN_DENTAL_DEVELOPER_KEY = "devkey123";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
process.env.PMS_SYNC_INLINE = "false";
process.env.JOBS_ENABLED = "false";
