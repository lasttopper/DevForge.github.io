# Runbook — operating, debugging, scaling

- [Daily checks](#daily-checks)
- [Useful queries](#useful-queries)
- [Troubleshooting](#troubleshooting)
- [WhatsApp bans](#whatsapp-bans)
- [Keeping Evolution awake](#keeping-evolution-awake)
- [Scaling](#scaling)
- [Compliance](#compliance)

---

## Daily checks

```sql
-- pipeline at a glance
select status, count(*) from leads group by status order by count(*) desc;

-- anything stuck mid-flight for over a day?
select business_name, status, updated_at
from leads
where status in ('engaged', 'prototype_sent', 'payment_sent')
  and updated_at < now() - interval '24 hours'
order by updated_at;
```

Also glance at n8n **Executions** filtered to *Error*.

---

## Useful queries

```sql
-- conversion funnel
select
  count(*) filter (where status <> 'new')                              as contacted,
  count(*) filter (where status in ('engaged','prototype_sent','payment_sent','paid','delivered')) as replied,
  count(*) filter (where status in ('prototype_sent','payment_sent','paid','delivered'))           as prototyped,
  count(*) filter (where status in ('paid','delivered'))               as paid
from leads;

-- revenue
select count(*) as sales, sum(amount)/100.0 as rupees
from payments where status = 'paid';

-- full transcript for one lead
select direction, channel, intent, left(body, 120) as preview, created_at
from messages where lead_id = '<uuid>' order by created_at;

-- which niches actually reply?
select l.niche,
       count(*) as leads,
       count(*) filter (where l.status not in ('new','contacted','lost')) as engaged
from leads l group by l.niche order by engaged desc;
```

---

## Troubleshooting

### Workflow 1

| Symptom | Cause | Fix |
|---|---|---|
| Apify node 401 | Token wrong or missing `Bearer ` | Header Auth value must be `Bearer apify_api_...` |
| Apify returns `[]` | Search too narrow, or credits exhausted | Broaden the query; check the Apify console for remaining credit |
| Everything filtered out | Most businesses in that niche already have sites | Try trades (plumber, electrician, tiffin, salon) rather than restaurants |
| `is_new: false` for all | Already scraped these places | Normal — change niche/city in **🎯 Search Plan** |
| Emails send, WhatsApp doesn't | Evolution disconnected | `curl $EVOLUTION_API_URL/instance/connectionState/sales-bot -H "apikey: $KEY"` |
| WhatsApp 400 "invalid number" | Wrong phone format | Must be digits only, country code, **no `+`** — e.g. `919876543210` |

### Workflow 2

| Symptom | Cause | Fix |
|---|---|---|
| Webhook never fires | Workflow inactive, or test URL registered | Activate it; re-register with the `/webhook/` production path |
| Replies ignored | Sender not matched to a contact | `select * from sales_find_contact('919876543210');` — the RPC matches on the last 10 digits |
| Everything → QUESTION | Model ignoring the format instruction | Switch `OPENROUTER_MODEL_TRIAGE` to a larger free model |
| Auto-replies get answered | Out-of-office wording not in the regex | Add the phrase to the guard in **🏷 Parse Intent** |
| IMAP misses mail | Gmail marks it read elsewhere | Use a dedicated inbox; the trigger only reads unseen messages |

### Workflow 3

| Symptom | Cause | Fix |
|---|---|---|
| "Generated HTML failed validation" | Free model truncated the page | Expected occasionally. Upgrade `OPENROUTER_MODEL_CODER` — a paid model costs a few cents per site |
| Vercel 403 | Token lacks scope | Create a new token with full account scope |
| Vercel 409 name conflict | Project slug already used | Slug includes the lead id; only collides on a manual retry — safe to re-run |
| Razorpay `amount` error | Amount in rupees not paise | `OFFER_PRICE_PAISE=150000` means ₹1,500 |
| Razorpay contact error | Malformed phone | The payload node only includes `contact` when a phone exists; check the number's country code |

### Workflow 4

| Symptom | Cause | Fix |
|---|---|---|
| Signature always invalid | Raw Body turned off | Re-enable **Raw Body** on the webhook node — HMAC needs exact bytes |
| Signature invalid, Raw Body on | Secret mismatch | `RAZORPAY_WEBHOOK_SECRET` must equal the dashboard value exactly |
| "not in the payments table" | Link created outside this system | Only links created by Workflow 3 are tracked |
| Two receipts sent | Shouldn't happen | `sales_record_payment_paid` is idempotent; check for duplicate rows in `payments` |
| Full build throws | Model truncated a **paid** build | Deliberate loud failure. Build manually, then `select sales_mark_delivered('<lead_id>', '<url>');` |

### Anywhere

**OpenRouter 429.** Free models are rate-limited per minute and per day. The Hermes
nodes retry three times with a 5 s backoff. If it persists, lower
`MAX_NEW_LEADS_PER_RUN`, spread the schedule, or add $10 to OpenRouter — that unlocks
much higher free-tier limits.

**Expressions resolve to `undefined`.** Node names are the reference key, so renaming a
node breaks every `$('Old Name')` that pointed at it. Run `npm run validate` — it
catches exactly this.

---

## WhatsApp bans

The single biggest operational risk. WhatsApp bans numbers that behave like broadcast
spam.

**Prevention**

- Dedicated SIM. Never your personal or main business number.
- Warm up: 5–10 manual messages/day for a week, with real back-and-forth, before automating.
- Stay under ~40 messages/day per number for the first month.
- The template already paces one lead at a time with a random 45–120 s gap — don't remove it.
- Personalise. Identical text sent 50 times is the strongest ban signal there is.
- Fill in the profile: photo, business name, description.
- Honour opt-outs instantly. The `NOT_INTERESTED` path exists for exactly this.

**If banned**

1. Appeal in-app (Settings → Help). Occasionally works.
2. Otherwise: new SIM, new instance, rescan. Your Supabase data is unaffected.
3. Halve your volume when you resume.

Email is the safer channel to lean on. Gmail SMTP gives 500/day and doesn't ban you for
a bad week.

---

## Keeping Evolution awake

Railway's free tier sleeps on inactivity, which drops the WhatsApp session. Add a small
n8n workflow: **Schedule (every 30 min) → HTTP GET**
`{{$env.EVOLUTION_API_URL}}/instance/connectionState/sales-bot` with the `apikey`
header.

Extend it to alert you when `state !== 'open'` so you find out before a day's replies
vanish.

---

## Scaling

**More volume**

1. Widen **🎯 Search Plan** and raise `SEARCHES_PER_RUN`.
2. Raise `MAX_NEW_LEADS_PER_RUN` gradually — 10 → 20 → 40, a week apart.
3. Add WhatsApp numbers (a second Evolution instance) before pushing one number harder.
4. Email scales more safely than WhatsApp. Consider a transactional provider
   (Resend, SendGrid) above ~500/day.

**Better conversion**

The prompts matter more than the volume. In rough order of impact:

1. **✍️ Build Copy Prompt** (Workflow 1) — the opening message decides everything.
2. **🎨 Build Site Prompt** (Workflow 3) — a striking mockup closes the sale.
3. **🧠 Build Triage Prompt** (Workflow 2) — misclassification loses warm leads.

Measure before and after:

```sql
select date_trunc('week', created_at) as week,
       count(*) as leads,
       round(100.0 * count(*) filter (where status not in ('new','contacted','lost')) / nullif(count(*),0), 1) as reply_pct
from leads group by 1 order by 1 desc;
```

**Cost ceiling.** Apify's $5 covers ~5,000 places/month. Beyond that: Apify pay-as-you-go,
or swap in a cheaper source (Google Places API, OpenStreetMap Overpass for trades).

---

## Compliance

Not legal advice — but don't skip this.

- **India (DPDP Act)** — B2B outreach to publicly listed business numbers is generally
  acceptable; honour opt-outs immediately and keep a record. `NOT_INTERESTED` marks both
  contact and lead so they're never messaged again.
- **WhatsApp Business Policy** — unsolicited bulk messaging violates it regardless of
  local law. Low volume and genuine personalisation are what keep you inside the lines.
- **GDPR (EU leads)** — legitimate interest can cover B2B outreach, but you need a
  lawful-basis record, a clear opt-out, and honest sender identity. Don't target EU
  leads with this template without reading up first.
- **CAN-SPAM (US)** — requires a real physical postal address and a working unsubscribe
  in commercial email. The default templates include neither; add them before mailing US
  businesses.

Practical minimum: use your real name and business, make opting out trivial, honour it
instantly, and don't message anyone twice who said no.
