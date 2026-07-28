# Omnichannel AI Sales Machine — n8n Template Pack

Four importable n8n workflows that find local businesses with no website, pitch them
on email + WhatsApp, triage the replies with an LLM, build and deploy a free prototype,
take payment via Razorpay, then build and deliver the real site.

```
Apify ──▶ n8n ──▶ Hermes/OpenRouter ──▶ Supabase ──▶ Razorpay ──▶ Vercel
```

| # | Workflow | Trigger | What it does |
|---|----------|---------|--------------|
| 1 | [Lead Discovery & Outreach](workflows/01-lead-discovery-outreach.json) | Schedule (6h) | Scrape Google Maps → keep businesses **without** a site → AI writes the copy → send on email + WhatsApp |
| 2 | [Reply Listener & Lock](workflows/02-reply-listener-lock.json) | IMAP + Webhook | Normalise replies from both channels → classify intent → lock the lead to one contact |
| 3 | [Prototype & Payment](workflows/03-prototype-and-payment.json) | Webhook + Schedule | AI builds a one-page site → deploy to Vercel → send link → create Razorpay payment link |
| 4 | [Payment & Delivery](workflows/04-payment-webhook-delivery.json) | Razorpay webhook | Verify HMAC → mark paid → AI builds the full site → deploy → deliver |

**Fixed cost: $0/month.** Only variable Razorpay fees on actual sales.

---

## Quick start

```bash
git clone <this-repo> && cd Ai-web-sales-agent-
npm install
npm run check          # rebuild the JSON + validate structure
```

1. **Database** — run [`sql/01_schema.sql`](sql/01_schema.sql) then
   [`sql/02_functions.sql`](sql/02_functions.sql) in the Supabase SQL editor.
2. **Env vars** — copy [`.env.example`](.env.example) into your n8n environment.
3. **Credentials** — create the six credentials in [the setup guide](docs/SETUP.md#4-credentials).
4. **Import** — drag the four files from `workflows/` into n8n.
5. **Dry run** — set `DRY_RUN=true`, execute Workflow 1 manually, read the generated copy.
6. **Go live** — set `DRY_RUN=false` and activate.

Full step-by-step instructions, including Evolution API on Railway and the
Razorpay webhook: **[docs/SETUP.md](docs/SETUP.md)**.

---

## How it hangs together

```
                    ┌──────────────────────────────────────┐
 Schedule ─────────▶│ 1 · Discovery & Outreach             │
                    │   Apify → filter → Supabase → AI     │
                    │   → Gmail + WhatsApp                 │
                    └──────────────┬───────────────────────┘
                                   │ status: contacted
                    ┌──────────────▼───────────────────────┐
 IMAP ─────────────▶│ 2 · Reply Listener & Lock            │
 Evolution webhook ▶│   normalise → AI triage → lock lead  │
                    └───┬──────────────┬───────────────────┘
            INTERESTED  │              │ APPROVED
                    ┌───▼──────────────▼───────────────────┐
                    │ 3 · Prototype & Payment              │
                    │   AI HTML → Vercel → send link       │
                    │   Razorpay link → send               │
                    └──────────────┬───────────────────────┘
                                   │ customer pays
                    ┌──────────────▼───────────────────────┐
 Razorpay webhook ─▶│ 4 · Payment & Delivery               │
                    │   verify HMAC → full build → deliver │
                    └──────────────────────────────────────┘
```

Lead status machine:

```
new → contacted → engaged → prototype_sent → payment_sent → paid → delivered
                     └──────────── lost ◀───────────┘
```

---

## What's different from a naive build

These are the things that turn "works in the demo" into "survives a week of real traffic":

**Atomic database operations.** Dedupe + insert happen inside one Postgres function
([`sales_upsert_lead`](sql/02_functions.sql)), so two overlapping runs can't create
duplicate leads. Work is claimed with `FOR UPDATE SKIP LOCKED` so the safety-net
schedule can never double-build a prototype someone is already paying for.

**Idempotent payments.** Razorpay retries webhooks for 24 hours.
`sales_record_payment_paid` returns `already_paid`, so a replay stops dead instead of
sending a second receipt.

**Real signature verification.** Workflow 4 does a `timingSafeEqual` HMAC-SHA256 check
against the raw request body. There are tests that assert forged signatures and
tampered bodies are rejected.

**The lock is one transaction.** When someone replies, `sales_lock_lead` promotes them
to `primary_contact_id` and marks every other contact at that business `locked` in a
single statement — you never end up negotiating with two people at the same shop.

**LLM output is never trusted.** Every AI call is followed by a parser that strips
markdown fences, extracts the JSON or HTML, validates it, and falls back to a
hand-written template. A flaky free model degrades the copy; it doesn't break the send.

**WhatsApp ban safety.** Outreach runs one lead at a time with a random 45–120 s pause,
capped per run. Auto-replies, bounces, group chats and your own messages are all
filtered out before they reach the AI.

---

## Repo layout

```
workflows/     the four importable n8n JSON files  ← the deliverable
sql/           Supabase schema + 12 RPC functions
docs/SETUP.md  full setup guide (Railway, Evolution, Razorpay, Vercel)
docs/RUNBOOK.md troubleshooting + scaling
scripts/       the builder + test suite that generate and check workflows/
```

The JSON in `workflows/` is **generated**. Edit `scripts/build/*.mjs` and run
`npm run build` rather than hand-editing the JSON, so the checks keep passing.

---

## Tests

```bash
npm run build       # regenerate workflows/ from scripts/build/
npm run validate    # structure: connections, orphans, $() refs, JSON bodies
npm test            # execute all 20 Code nodes against realistic fixtures (48 assertions)
npm run test:sql    # run the schema + all 12 RPCs on real Postgres (PGlite/WASM)
npm run verify      # check node types + typeVersions vs real n8n-nodes-base
npm run check       # build + validate + test + test:sql
```

`npm test` runs the actual Code-node JavaScript inside a mock n8n runtime, with
fixtures taken from real Apify / Evolution / Razorpay payload shapes — including the
nasty ones: truncated LLM output, forged webhook signatures, WhatsApp stickers,
out-of-office autoresponders, duplicate payment webhooks.

Two real bugs were caught this way while building:
- PL/pgSQL `RETURNS TABLE` output names shadowing real column names
  (fixed with `#variable_conflict use_column`) — only fails at call time, never at
  `CREATE FUNCTION` time.
- `looseTypeValidation` placed at the top level of If/Switch nodes instead of inside
  `options`, which n8n silently ignores.

---

## Costs

| Service | Tier used | Cost |
|---|---|---|
| Apify Google Maps Scraper | $5 free credit/mo (~5,000 places) | $0 |
| n8n | self-hosted | $0 |
| Supabase | free (500 MB) | $0 |
| OpenRouter | free models (`:free` slugs) | $0 |
| Gmail SMTP | 500 emails/day | $0 |
| Evolution API | Railway free tier | $0 |
| Vercel | hobby | $0 |
| Razorpay | pay per transaction | 2% of sales |

---

## Licence

MIT. Sending unsolicited messages is regulated differently everywhere —
check DPDP / GDPR / CAN-SPAM and WhatsApp's Business Policy before you scale.
See [docs/RUNBOOK.md](docs/RUNBOOK.md#compliance).
