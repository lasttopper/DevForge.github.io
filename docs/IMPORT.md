# How to use this in n8n

The short version: **download 4 JSON files → import → paste your keys into one node → test with sending disabled.**

- [Step 1: Get the files](#step-1-get-the-files)
- [Step 2: Import into n8n](#step-2-import-into-n8n)
- [Step 3: Set up the database](#step-3-set-up-the-database)
- [Step 4: Fill in the Config node](#step-4-fill-in-the-config-node)
- [Step 5: Attach credentials](#step-5-attach-credentials)
- [Step 6: Connect the webhooks](#step-6-connect-the-webhooks)
- [Step 7: Test with sending off](#step-7-test-with-sending-off)
- [Step 8: Go live](#step-8-go-live)
- [Cloud vs self-hosted](#n8n-cloud-vs-self-hosted)

---

## Step 1: Get the files

You only need the four files in `workflows/`. Either clone the repo:

```bash
git clone -b arena/019faa08-ai-web-sales-agent \
  https://github.com/lasttopper/Ai-web-sales-agent-.git
cd Ai-web-sales-agent-/workflows
```

…or open each file on GitHub and click **Raw → Save As**.

```
01-lead-discovery-outreach.json
02-reply-listener-lock.json
03-prototype-and-payment.json
04-payment-webhook-delivery.json
```

## Step 2: Import into n8n

For each file: **Workflows → ⋯ (top-right) → Import from File…**

Or open a blank canvas, copy the file contents, and press <kbd>Ctrl/Cmd</kbd>+<kbd>V</kbd> —
n8n pastes workflow JSON directly onto the canvas.

Import all four. They'll show warning triangles until you add credentials — that's expected.

> **Import them in order (01 → 04).** Workflow 2 calls Workflow 3 by webhook URL, so 3
> should exist before 2 goes live. Nothing breaks if you don't, but you'll get a failed
> handoff on the first interested reply.

## Step 3: Set up the database

Nothing works without this — every workflow reads and writes Supabase.

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste all of [`sql/01_schema.sql`](../sql/01_schema.sql) → **Run**.
3. New query → paste all of [`sql/02_functions.sql`](../sql/02_functions.sql) → **Run**.

Verify it took:

```sql
select routine_name from information_schema.routines
where routine_name like 'sales_%' order by 1;
-- expect 12 rows
```

Then grab **Settings → API**: your **Project URL** and your **`service_role`** key.

## Step 4: Fill in the Config node

Every workflow starts with a node called **⚙️ Config**. It's the only place you edit
settings — nothing is hardcoded deeper in the graph.

Open it and you'll see rows like:

```
supabase_url    ={{ $env.SUPABASE_URL || 'https://YOUR-PROJECT.supabase.co' }}
sender_name     ={{ $env.SENDER_NAME || 'Alex' }}
price_paise     ={{ Number($env.OFFER_PRICE_PAISE || 150000) }}
```

**Two ways to fill these in — pick one:**

**Option A — environment variables (self-hosted, recommended).** Leave the node alone and
set the variables in your n8n environment ([`.env.example`](../.env.example) lists them
all). Nothing secret ends up in the workflow JSON.

```yaml
# docker-compose.yml
services:
  n8n:
    environment:
      - SUPABASE_URL=https://xxxx.supabase.co
      - SENDER_EMAIL=you@yourdomain.com
      - SENDER_NAME=Alex
      - AGENCY_NAME=Studio Nova
      - EVOLUTION_API_URL=https://your-evolution.up.railway.app
      - N8N_WEBHOOK_BASE=https://your-n8n.example.com
      - RAZORPAY_WEBHOOK_SECRET=whsec_...
      - DRY_RUN=true
      # n8n 2.0+ blocks $env in Code nodes unless you set this:
      - N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

**Option B — type the values in directly (n8n Cloud, or if you prefer).** Replace each
expression with a plain value: click the row, toggle **Expression → Fixed**, type it in.

```
supabase_url    https://xxxx.supabase.co
sender_name     Alex
price_paise     150000
```

> ⚠️ If you do this, the **Config node must be edited in all four workflows** — they each
> have their own copy. And don't commit the JSON afterwards: `razorpay_webhook_secret`
> would be sitting in plain text.

The settings you'll actually care about:

| Field | Default | What it does |
|---|---|---|
| `dry_run` | `true` | **Leave this on for your first runs.** Generates copy, sends nothing |
| `max_new_leads_per_run` | `10` | Hard cap on messages per execution |
| `price_paise` | `150000` | **In paise.** 150000 = ₹1,500 |
| `build_mode` | `auto` | `manual` = you build the paid site yourself |
| `model_coder` | a `:free` model | Upgrade this first if generated HTML gets truncated |

## Step 5: Attach credentials

Create these in **Credentials → Add credential**, then open each flagged node and pick it
from the dropdown.

| Credential type | Name it | Configuration |
|---|---|---|
| Header Auth | `Apify` | Name `Authorization`, Value `Bearer apify_api_...` |
| Header Auth | `OpenRouter` | Name `Authorization`, Value `Bearer sk-or-v1-...` |
| Header Auth | `Evolution` | Name `apikey`, Value your Evolution API key |
| Header Auth | `Vercel` | Name `Authorization`, Value `Bearer ...` |
| Supabase API | `Supabase` | Host = project URL, Service Role Secret = `service_role` key |
| SMTP | `Gmail SMTP` | `smtp.gmail.com`, port `465`, SSL, Gmail + **App Password** |
| IMAP | `Gmail IMAP` | `imap.gmail.com`, port `993`, SSL, same App Password |
| Basic Auth | `Razorpay` | User = Key ID, Password = Key Secret |

> **Four credentials share the "Header Auth" type**, so the dropdown shows all of them on
> every HTTP node. Match them by node name:
>
> | Node | Credential |
> |---|---|
> | 🗺 Apify · Google Maps Scraper | Apify |
> | 🧠 Hermes · … *(5 nodes)* | OpenRouter |
> | 💬 WhatsApp / Send Receipt (WA) / Deliver By WhatsApp *(5 nodes)* | Evolution |
> | ▲ Deploy To Vercel / ▲ Deploy Final Site | Vercel |

Gmail needs an **App Password** (Google Account → Security → 2-Step Verification → App
passwords), not your normal password.

WhatsApp needs Evolution API running — see [SETUP.md §2](SETUP.md#2-evolution-api-whatsapp-on-railway).
**You can skip it for now**: with no phone numbers, the workflows just use email.

## Step 6: Connect the webhooks

Three workflows expose webhooks. n8n shows the URL when you open the webhook node.

| Workflow | Path | Who calls it |
|---|---|---|
| 02 | `/webhook/whatsapp-reply` | Evolution API, on incoming WhatsApp |
| 03 | `/webhook/build-prototype` | Workflow 2, internally |
| 04 | `/webhook/razorpay-webhook` | Razorpay, on payment |

**Evolution → Workflow 2:**

```bash
curl -X POST "$EVOLUTION_API_URL/webhook/set/sales-bot" \
  -H "apikey: $KEY" -H "Content-Type: application/json" \
  -d '{"webhook":{"enabled":true,
       "url":"https://YOUR-N8N/webhook/whatsapp-reply",
       "events":["MESSAGES_UPSERT"]}}'
```

**Razorpay → Workflow 4:** Dashboard → Settings → Webhooks → Add:
URL `https://YOUR-N8N/webhook/razorpay-webhook`, events `payment_link.paid` and
`payment.captured`, secret = your `razorpay_webhook_secret`.

> Use the **production** path `/webhook/...`, not `/webhook-test/...`, and **activate the
> workflow** — an inactive workflow returns 404 on its production URL. This is the single
> most common "why isn't it firing" cause.

## Step 7: Test with sending off

Don't skip this. `dry_run` exists so your first execution can't message a real business.

**a. Dry run.** Confirm `dry_run` is `true`. Open Workflow 1 → **Execute Workflow**.

It scrapes, saves leads, writes copy, then stops at *📋 Preview Only (no send)*. Click
that node and read the generated `email_body` and `whatsapp_body`.

**This is the highest-leverage moment in the whole setup.** If the copy sounds robotic,
edit the prompt in **✍️ Build Copy Prompt** and run again. Iterate until you'd be happy
receiving it.

**b. Check the data landed.**

```sql
select business_name, niche, status from leads order by created_at desc limit 10;
```

**c. Send exactly one.** Set `dry_run` → `false` and `max_new_leads_per_run` → `1`.
Execute once. Check the message arrived and looks right.

**d. Test replies.** Reply to it. Workflow 2 should classify and lock the lead:

```sql
select status, primary_contact_id from leads order by updated_at desc limit 1;
select intent, direction, left(body,80) from messages order by created_at desc limit 5;
```

**e. Test payment** in Razorpay **Test Mode** with a test card before touching live keys.

## Step 8: Go live

1. `dry_run` → `false`
2. **Activate** all four workflows (toggle, top-right)
3. Start small: `max_new_leads_per_run` = 5
4. Set an **Error Workflow** (Workflow Settings → Error Workflow) so failures reach you
5. Read the first ~20 conversations yourself before scaling

Then keep [RUNBOOK.md](RUNBOOK.md) open — it has a symptom → cause → fix table per workflow.

---

## n8n Cloud vs self-hosted

Both work. The difference is how config reaches the workflows.

| | Self-hosted | n8n Cloud |
|---|---|---|
| Config | Env vars (Option A) | Type values into ⚙️ Config (Option B) |
| `$env` in Code nodes | Needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` on 2.0+ | Not available |
| Webhook URLs | Set `WEBHOOK_URL` to your public HTTPS URL | Provided automatically |
| Cost | Free | Paid plan |

**On n8n 2.0+ self-hosted**, `$env` is blocked in Code nodes by default. Either set
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, or use Option B. All `$env` access is concentrated
in the ⚙️ Config node, so it's one node per workflow to change either way.

**Local testing?** Your webhooks need a public URL. Run
`npx localtunnel --port 5678` (or use n8n's built-in tunnel: `n8n start --tunnel`) and set
`N8N_WEBHOOK_BASE` to the URL it gives you.

---

## Common first-run problems

| What you see | Why | Fix |
|---|---|---|
| Red triangle on a node | No credential attached | Open it, pick from the dropdown |
| `ERROR: access to env vars denied` | n8n 2.0 blocks `$env` | `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, or use Option B |
| `supabase_url` resolves to `YOUR-PROJECT` | Env var not set / n8n not restarted | Restart n8n after changing env vars |
| Apify 401 | Missing `Bearer ` prefix | Value must be `Bearer apify_api_...` |
| Apify returns nothing | Every match already has a website | Try trades: plumber, electrician, salon, tiffin |
| `function sales_upsert_lead does not exist` | `02_functions.sql` not run | Re-run it; check for 12 routines |
| Webhook 404 | Workflow not activated | Activate it; use `/webhook/` not `/webhook-test/` |
| WhatsApp "invalid number" | Wrong format | Digits only with country code, no `+`: `919876543210` |
| OpenRouter 429 | Free-model rate limit | Lower `max_new_leads_per_run`, or add $10 to OpenRouter |

Anything else: [RUNBOOK.md](RUNBOOK.md) has the full table.
