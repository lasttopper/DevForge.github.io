# Setup Guide

Work through this in order. Budget about 90 minutes for the first run-through;
the Evolution/WhatsApp step is the slowest.

- [1. Supabase](#1-supabase)
- [2. Evolution API on Railway](#2-evolution-api-whatsapp-on-railway)
- [3. Environment variables](#3-environment-variables)
- [4. Credentials](#4-credentials)
- [5. Import the workflows](#5-import-the-workflows)
- [6. Wire the webhooks](#6-wire-the-webhooks)
- [7. Test before you send anything](#7-test-before-you-send-anything)
- [8. Go live](#8-go-live)

---

## 1. Supabase

Create a project at [supabase.com](https://supabase.com) (free tier).

In **SQL Editor**, run these two files in order:

1. [`sql/01_schema.sql`](../sql/01_schema.sql) — four tables, indexes, RLS
2. [`sql/02_functions.sql`](../sql/02_functions.sql) — twelve RPC functions

Then grab from **Settings → API**:

- **Project URL** → `SUPABASE_URL`
- **`service_role` key** → used by the Supabase credential in n8n

> The workflows use the **service role** key. It bypasses RLS, which is what we want
> for a backend automation — but it must never be exposed to a browser. RLS is enabled
> on all tables so the `anon` key can't read your pipeline even if it leaks.

### Why RPC functions instead of Supabase nodes?

The template calls Postgres functions rather than chaining Supabase CRUD nodes:

- **Atomic** — dedupe-and-insert is one statement, so parallel executions can't create duplicate leads
- **Fewer HTTP calls** — one round trip instead of four or five (kinder to free tiers)
- **Safe locking** — "lock the lead to one contact" is a transaction, not a read-modify-write loop
- **Idempotent** — payment webhooks can be replayed safely

---

## 2. Evolution API (WhatsApp) on Railway

1. Create an account at [railway.app](https://railway.app).
2. **New Project → Deploy from Docker Image**
3. Image: `atendai/evolution-api:latest`
4. Environment variables:

   | Key | Value |
   |---|---|
   | `SERVER_TYPE` | `http` |
   | `AUTHENTICATION_TYPE` | `apikey` |
   | `AUTHENTICATION_API_KEY` | a long random string you generate |
   | `DATABASE_ENABLED` | `false` |
   | `CONFIG_SESSION_PHONE_CLIENT` | `Chrome` |

5. Add a **persistent volume** mounted at `/evolution/instances` (1 GB), otherwise
   you re-scan the QR code on every redeploy.
6. Deploy, then note the public URL → `EVOLUTION_API_URL`.

Create the instance:

```bash
curl -X POST "$EVOLUTION_API_URL/instance/create" \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName":"sales-bot","qrcode":true,"integration":"WHATSAPP-BAILEYS"}'
```

The response contains a base64 QR code. Render it (paste the string into any
base64-image viewer) and scan it from WhatsApp on a **dedicated phone number** —
not your personal one, and not your main business line.

Check it's connected:

```bash
curl "$EVOLUTION_API_URL/instance/connectionState/sales-bot" -H "apikey: $KEY"
# → { "instance": { "state": "open" } }
```

> ⚠️ **Warm the number up.** A brand-new SIM that sends 50 cold messages on day one
> gets banned. Send 5–10/day by hand for a week first, have a few real conversations,
> then let the automation take over slowly. See [RUNBOOK.md](RUNBOOK.md#whatsapp-bans).

Railway's free tier sleeps on inactivity — [keep it warm](RUNBOOK.md#keeping-evolution-awake).

---

## 3. Environment variables

Copy [`.env.example`](../.env.example) into your n8n instance's environment
(Docker `environment:`, Railway variables, or a `.env` next to `docker-compose.yml`).

The workflows read these through the **⚙️ Config** node at the top of each canvas,
so you can change pricing, models, or throttles without editing any node.

Required:

```bash
SUPABASE_URL=https://xxxx.supabase.co
EVOLUTION_API_URL=https://your-evolution.up.railway.app
EVOLUTION_INSTANCE=sales-bot
N8N_WEBHOOK_BASE=https://your-n8n.example.com
SENDER_EMAIL=you@yourdomain.com
SENDER_NAME=Alex
AGENCY_NAME=Studio Nova
RAZORPAY_WEBHOOK_SECRET=whsec_...
```

Worth tuning:

| Variable | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `false` | `true` = generate copy, send nothing |
| `MAX_NEW_LEADS_PER_RUN` | `10` | Hard cap per execution |
| `SEARCHES_PER_RUN` | `1` | How many niche/city pairs per run |
| `APIFY_MAX_PLACES` | `20` | Places per search (watch your credits) |
| `OFFER_PRICE_PAISE` | `150000` | **In paise.** 150000 = ₹1,500 |
| `BUILD_MODE` | `auto` | `manual` = you build the paid site yourself |
| `DEFAULT_COUNTRY_CODE` | `91` | Prefixed to bare 10-digit numbers |
| `OPENROUTER_MODEL_CODER` | `deepseek/...:free` | Upgrade this one first if HTML gets truncated |

---

## 4. Credentials

Create these six in **n8n → Credentials**. The workflows reference them by type, so
you only need to pick them once per node after import.

| # | Credential type | Used by | Configuration |
|---|---|---|---|
| 1 | **Header Auth** — name it `Apify` | Apify node | Name `Authorization`, Value `Bearer YOUR_APIFY_TOKEN` |
| 2 | **Header Auth** — name it `OpenRouter` | all Hermes nodes | Name `Authorization`, Value `Bearer sk-or-v1-...` |
| 3 | **Header Auth** — name it `Evolution` | WhatsApp send nodes | Name `apikey`, Value your `AUTHENTICATION_API_KEY` |
| 4 | **Header Auth** — name it `Vercel` | deploy nodes | Name `Authorization`, Value `Bearer YOUR_VERCEL_TOKEN` |
| 5 | **Supabase API** | all Supabase RPC nodes | Host = your project URL, Service Role Secret = `service_role` key |
| 6 | **SMTP** | all email send nodes | `smtp.gmail.com`, port `465`, SSL on, your Gmail + **App Password** |
| 7 | **IMAP** | Workflow 2 trigger | `imap.gmail.com`, port `993`, SSL on, same App Password |
| 8 | **Basic Auth** — name it `Razorpay` | payment link node | User = Key ID, Password = Key Secret |

> Gmail needs an **App Password** (Google Account → Security → 2-Step Verification →
> App passwords), not your login password.

Several nodes share the "Header Auth" type. After importing, open each HTTP node once
and pick the right one from the dropdown — the node names make it obvious which is which.

---

## 5. Import the workflows

In n8n: **Workflows → Import from File**, one at a time:

```
workflows/01-lead-discovery-outreach.json
workflows/02-reply-listener-lock.json
workflows/03-prototype-and-payment.json
workflows/04-payment-webhook-delivery.json
```

Each canvas has sticky notes explaining that phase. Assign credentials to any node
showing a warning triangle.

**Edit the 🎯 Search Plan node in Workflow 1** — it ships with placeholder niches:

```js
const searches = [
  { niche: 'plumber', location: 'Jaipur', query: 'plumber in Jaipur' },
  // ...your actual targets
];
```

---

## 6. Wire the webhooks

### Evolution → Workflow 2

Point Evolution at your reply listener:

```bash
curl -X POST "$EVOLUTION_API_URL/webhook/set/sales-bot" \
  -H "apikey: $KEY" -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://YOUR-N8N/webhook/whatsapp-reply",
      "webhookByEvents": false,
      "events": ["MESSAGES_UPSERT"]
    }
  }'
```

> Use the **production** URL (`/webhook/...`), not the test URL (`/webhook-test/...`),
> and make sure Workflow 2 is **activated** — inactive workflows return 404.

### Razorpay → Workflow 4

Dashboard → **Settings → Webhooks → Add New Webhook**

- URL: `https://YOUR-N8N/webhook/razorpay-webhook`
- Secret: same value as `RAZORPAY_WEBHOOK_SECRET`
- Events: `payment_link.paid` and `payment.captured`

> The webhook node has **Raw Body** enabled deliberately — HMAC is computed over the
> exact bytes Razorpay sent. Turning it off breaks signature verification.

Start in **Test Mode** and use Razorpay's test cards until you've watched one full
payment flow succeed.

---

## 7. Test before you send anything

Run these in order. Don't skip to step 8.

**a. Repo checks**

```bash
npm run check
```

**b. Dry run of the discovery workflow**

Set `DRY_RUN=true`, restart n8n, execute Workflow 1 manually.

It scrapes, stores leads, and generates copy, but routes to
*📋 Preview Only (no send)*. Open that node and read the email/WhatsApp text. If the
copy is generic or wrong, tune the prompt in **✍️ Build Copy Prompt** and repeat —
this is the single highest-leverage thing you can do.

**c. Check the data landed**

```sql
select business_name, niche, location, status from leads order by created_at desc limit 10;
select name, email, phone, status from contacts order by created_at desc limit 10;
```

**d. Send one real message**

Set `DRY_RUN=false` and `MAX_NEW_LEADS_PER_RUN=1`. Execute once. Confirm the message
arrives, looks right, and comes from the number/address you expect.

**e. Test the reply path**

Reply to that message. Workflow 2 should fire, classify it, and lock the lead:

```sql
select status, primary_contact_id from leads where id = '<lead_id>';
select intent, body from messages order by created_at desc limit 5;
```

**f. Test the payment webhook**

Create a test payment link (execute Workflow 3 with `stage: "payment"`), pay it with a
Razorpay test card, and confirm Workflow 4 marks it paid:

```sql
select status, paid_at from payments order by created_at desc limit 5;
```

---

## 8. Go live

1. `DRY_RUN=false`
2. Activate all four workflows
3. Start conservative: `MAX_NEW_LEADS_PER_RUN=5`, `WHATSAPP_DAILY_CAP=20`
4. Set an **Error Workflow** (Workflow Settings → Error Workflow) so failures ping you —
   Workflow 4 throws on purpose if a paid build fails validation, and you want to know
5. Watch the first 20 conversations by hand before scaling anything

Then read [RUNBOOK.md](RUNBOOK.md) for troubleshooting and scaling.
