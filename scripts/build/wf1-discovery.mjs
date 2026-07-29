/**
 * WORKFLOW 1 — Lead Discovery & Omnichannel Outreach (Phase 1)
 *
 * Schedule → Apify Google Maps → keep businesses WITHOUT a website →
 * atomic upsert into Supabase → Hermes writes the email + WhatsApp copy →
 * send on every channel we have → mark contacted.
 */
import {
  Workflow, V, set, code, http, noOp, merge, ifNode, filterNode, switchNode, wait,
  cond, OP, HEADER_AUTH, supabaseRpc, openRouter, evolutionSendText, sendEmail,
} from '../lib/n8n.mjs';
import { configNode, HEADER_COLOR, WARN_COLOR, OK_COLOR } from './common.mjs';

export default function build() {
  const wf = new Workflow('01 · Lead Discovery & Omnichannel Outreach', {
    tags: ['ai-sales-machine'],
  });

  /* ---------------- trigger + config ---------------- */
  wf.add('⏱ Every 6 Hours', 'n8n-nodes-base.scheduleTrigger', V.scheduleTrigger, [-480, 0], {
    rule: { interval: [{ field: 'hours', hoursInterval: 6 }] },
  });
  wf.add('▶️ Manual Test', 'n8n-nodes-base.manualTrigger', 1, [-480, 200], {});
  configNode(wf, [-240, 80]);

  /* ---------------- search plan ---------------- */
  code(
    wf,
    '🎯 Search Plan',
    [-20, 80],
    `// Edit this list — one entry per niche/city you want to farm.
// Keep it small: Apify's free \$5/month is roughly 5,000 places.
const searches = [
  { niche: 'plumber',      location: 'Jaipur',    query: 'plumber in Jaipur' },
  { niche: 'dentist',      location: 'Jaipur',    query: 'dental clinic in Jaipur' },
  { niche: 'gym',          location: 'Udaipur',   query: 'gym in Udaipur' },
];

// Rotate so every run works a different slice instead of always hammering
// the first search term (and re-scraping the same already-known places).
const perRun = Number(\$('⚙️ Config').first().json.searches_per_run || 1);
const cursor = Math.floor(Date.now() / (1000 * 60 * 60 * 6)) % searches.length;
const picked = [];
for (let i = 0; i < Math.min(perRun, searches.length); i++) {
  picked.push(searches[(cursor + i) % searches.length]);
}

return picked.map((s) => ({ json: s }));`,
  );

  /* ---------------- apify ---------------- */
  http(
    wf,
    '🗺 Apify · Google Maps Scraper',
    [220, 80],
    {
      method: 'POST',
      url: 'https://api.apify.com/v2/acts/compass~google-maps-scraper/run-sync-get-dataset-items',
      ...HEADER_AUTH,
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'timeout', value: '300' },
          { name: 'memory', value: '1024' },
        ],
      },
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={
  "searchStringsArray": [{{ JSON.stringify($json.query) }}],
  "maxCrawledPlacesPerSearch": {{ $('⚙️ Config').first().json.apify_max_places }},
  "language": "en",
  "skipClosedPlaces": true,
  "scrapeContacts": false,
  "proxyConfig": { "useApifyProxy": true }
}`,
      options: { timeout: 300000, response: { response: { neverError: false } } },
    },
    { retryOnFail: true, maxTries: 2, waitBetweenTries: 10000, alwaysOutputData: true },
  );

  /* ---------------- normalise + filter ---------------- */
  code(
    wf,
    '🧹 Normalise & Qualify',
    [460, 80],
    `// One Apify item == one Google Maps place.
// We keep only businesses that (a) have no website and (b) are reachable.
const cfg = \$('⚙️ Config').first().json;
const plan = \$('🎯 Search Plan').first().json;
const out = [];
const seen = new Set();

const digits = (v) => String(v || '').replace(/\\D/g, '');

for (const item of \$input.all()) {
  const p = item.json || {};

  // --- has a website already? not our customer ---
  const site = (p.website || p.webResults?.[0]?.url || '').trim();
  if (site && !/facebook\\.com|instagram\\.com|linktr\\.ee|wa\\.me/i.test(site)) continue;

  // --- permanently closed? skip ---
  if (p.permanentlyClosed === true || p.temporarilyClosed === true) continue;

  // --- contact details ---
  let phone = digits(p.phoneUnformatted || p.phone);
  if (phone && phone.length === 10) phone = (cfg.default_country_code || '91') + phone;   // bare Indian mobile
  if (phone && phone.length < 11) phone = '';                                             // landline/garbage
  const email = String(p.email || p.emails?.[0] || '').trim().toLowerCase();

  if (!phone && !email) continue;      // no way to reach them

  const key = phone || email;
  if (seen.has(key)) continue;         // duplicate inside this same batch
  seen.add(key);

  out.push({
    json: {
      business_name: p.title || p.name || '',
      niche: plan.niche,
      location: plan.location || p.city || '',
      google_place_id: p.placeId || p.fid || null,
      phone,
      email,
      contact_name: p.ownerName || '',
      metadata: {
        address: p.address || '',
        category: p.categoryName || '',
        rating: p.totalScore ?? null,
        reviews: p.reviewsCount ?? null,
        maps_url: p.url || '',
        source: 'apify:compass~google-maps-scraper',
      },
    },
  });
}

// Respect the per-run cap so we never blast 200 messages in one go.
const capped = out.slice(0, Number(cfg.max_new_leads_per_run || 10));

// Always emit something so the "nothing to do" branch is visible in the log.
return capped.length ? capped : [{ json: { empty: true, reason: 'no website-less businesses in this batch' } }];`,
  );

  ifNode(wf, '❓ Any Qualified Leads?', [700, 80], [
    cond('={{ $json.business_name }}', OP.strNotEmpty),
  ]);
  noOp(wf, '🚪 Nothing To Do', [940, 220]);

  /* ---------------- store ---------------- */
  supabaseRpc(
    wf,
    '💾 Upsert Lead + Contact',
    [940, 20],
    'sales_upsert_lead',
    `={
  "p_payload": {
    "business_name":   {{ JSON.stringify($json.business_name) }},
    "niche":           {{ JSON.stringify($json.niche) }},
    "location":        {{ JSON.stringify($json.location) }},
    "google_place_id": {{ JSON.stringify($json.google_place_id) }},
    "phone":           {{ JSON.stringify($json.phone) }},
    "email":           {{ JSON.stringify($json.email) }},
    "contact_name":    {{ JSON.stringify($json.contact_name) }},
    "metadata":        {{ JSON.stringify($json.metadata) }}
  }
}`,
    { onError: 'continueRegularOutput' },
  );

  code(
    wf,
    '🆕 Keep Only Brand-New Leads',
    [1180, 20],
    `// The RPC returns a single-row table -> unwrap it, drop anything we have
// already contacted before, and drop rows where the RPC errored.
const out = [];
for (const item of \$input.all()) {
  const row = Array.isArray(item.json) ? item.json[0] : (item.json?.[0] ?? item.json);
  if (!row || !row.lead_id) continue;
  if (row.is_new === false) continue;      // already in the pipeline
  out.push({ json: row });
}
return out;`,
  );

  /* ---------------- pacing loop ---------------- */
  wf.add('🔁 One Lead At A Time', 'n8n-nodes-base.splitInBatches', V.splitInBatches, [1420, 20], {
    batchSize: 1,
    options: { reset: false },
  });
  noOp(wf, '✅ Run Complete', [1660, -140]);

  /* ---------------- AI copywriter ---------------- */
  set(wf, '✍️ Build Copy Prompt', [1660, 60], [
    {
      name: 'system_prompt',
      value:
        "=You are a top-performing B2B outreach copywriter for {{ $('⚙️ Config').first().json.agency_name }}, a small web studio. You write like a real human: short sentences, zero corporate filler, no emoji spam, no 'I hope this email finds you well'. You always answer with raw JSON and nothing else.",
    },
    {
      name: 'prompt',
      value: `=Business: {{ $json.business_name }}
Industry: {{ $json.niche }}
City: {{ $json.location }}
Owner name (may be generic): {{ $json.contact_name }}
My name: {{ $('⚙️ Config').first().json.sender_name }}
My studio: {{ $('⚙️ Config').first().json.agency_name }}

This business has NO website. Write outreach offering a free, no-strings single-page website mockup built for them.

Rules:
- Reference the business by name and the fact they are a {{ $json.niche }} in {{ $json.location }}.
- Lead with what they lose without a site (customers googling them find nothing).
- The ask is tiny: "want me to send it over?" — never ask for money or a meeting.
- Email: max 90 words, plain text, no links, sign off as {{ $('⚙️ Config').first().json.sender_name }}.
- Subject: max 6 words, lowercase, looks like a human typed it, no clickbait.
- WhatsApp: max 35 words, casual, one question mark at the end.

Return ONLY this JSON object, no markdown fence, no commentary:
{"subject": "...", "email": "...", "whatsapp": "..."}`,
    },
  ]);

  openRouter(wf, '🧠 Hermes · Write Outreach', [1900, 60], {
    model: "$('⚙️ Config').first().json.model_copywriter",
    maxTokens: 700,
    temperature: 0.8,
  }, { onError: 'continueRegularOutput' });

  code(
    wf,
    '🔎 Parse AI Copy',
    [2140, 60],
    `// LLMs love to wrap JSON in prose or \`\`\`json fences. Be forgiving,
// and always fall back to a hand-written template so a flaky free model
// can never break the send.
const lead = \$('🔁 One Lead At A Time').item.json;
const cfg  = \$('⚙️ Config').first().json;

const raw = \$json?.choices?.[0]?.message?.content ?? '';

const fallback = {
  subject: \`quick idea for \${lead.business_name}\`,
  email:
\`Hi \${lead.contact_name && lead.contact_name !== 'Owner' ? lead.contact_name : 'there'},

I was looking up \${lead.niche}s in \${lead.location} and found \${lead.business_name} — but no website, so anyone who googles you lands on a competitor instead.

I build simple one-page sites for local businesses. I'd like to put together a free mockup for \${lead.business_name} so you can see what it would look like. No cost, no commitment.

Want me to send it over?

\${cfg.sender_name}\`,
  whatsapp:
\`Hi! I'm \${cfg.sender_name}. I noticed \${lead.business_name} doesn't have a website yet — I'd like to build you a free one-page mockup to look at. Want me to send it?\`,
};

function parse(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^\\\`\\\`\\\`(?:json)?/i, '').replace(/\\\`\\\`\\\`\$/, '').trim();
  const start = t.indexOf('{');
  const end   = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

const ai = parse(raw) || {};
const clean = (v, max) => String(v || '').replace(/\\s+\$/,'').slice(0, max);

const subject  = clean(ai.subject, 120)   || fallback.subject;
const email    = clean(ai.email, 2000)    || fallback.email;
const whatsapp = clean(ai.whatsapp, 600)  || fallback.whatsapp;

return [{
  json: {
    ...lead,
    subject,
    email_body: email,
    whatsapp_body: whatsapp,
    ai_used: Boolean(parse(raw)),
    has_email: Boolean(lead.email),
    has_phone: Boolean(lead.phone),
    dry_run: cfg.dry_run === true,
  },
}];`,
  );

  /* ---------------- dry run guard ---------------- */
  ifNode(wf, '🧪 Dry Run?', [2380, 60], [cond('={{ $json.dry_run }}', OP.boolTrue)]);
  noOp(wf, '📋 Preview Only (no send)', [2620, -80]);

  /* ---------------- channel routing ---------------- */
  switchNode(
    wf,
    '🔀 Route Channels',
    [2620, 160],
    [
      { key: 'email', conditions: [cond('={{ $json.has_email }}', OP.boolTrue)] },
      { key: 'whatsapp', conditions: [cond('={{ $json.has_phone }}', OP.boolTrue)] },
    ],
    { allMatchingOutputs: true },
  );

  sendEmail(wf, '📧 Gmail · Send Outreach', [2880, 60], {
    toExpr: '{{ $json.email }}',
    subjectExpr: '{{ $json.subject }}',
    textExpr: '{{ $json.email_body }}',
  });

  evolutionSendText(wf, '💬 WhatsApp · Send Outreach', [2880, 260], {
    numberExpr: '$json.phone',
    textExpr: '$json.whatsapp_body',
  });

  merge(wf, '🔗 Merge Sends', [3120, 160], 2);

  /* ---------------- bookkeeping ---------------- */
  code(
    wf,
    '🧾 Summarise Send',
    [3340, 160],
    `// Both channels may have fired for the same lead — collapse back to one item.
const lead = \$('🔎 Parse AI Copy').first().json;
let emailOk = false;
let waOk = false;

for (const item of \$input.all()) {
  const j = item.json || {};
  if (j.accepted !== undefined || j.messageId !== undefined) emailOk = true;
  if (j.key !== undefined || j.status !== undefined) waOk = true;
}

return [{
  json: {
    ...lead,
    sent_email: emailOk,
    sent_whatsapp: waOk,
    sent_any: emailOk || waOk,
    channel_used: [emailOk ? 'email' : null, waOk ? 'whatsapp' : null].filter(Boolean).join('+'),
  },
}];`,
  );

  supabaseRpc(
    wf,
    '📝 Log Outbound Message',
    [3580, 160],
    'sales_log_message',
    `={
  "p_lead_id":    {{ JSON.stringify($json.lead_id) }},
  "p_contact_id": {{ JSON.stringify($json.contact_id) }},
  "p_direction":  "outbound",
  "p_channel":    {{ JSON.stringify($json.channel_used || 'none') }},
  "p_body":       {{ JSON.stringify(($json.sent_email ? $json.email_body : '') + ($json.sent_whatsapp ? '\\n---\\n' + $json.whatsapp_body : '')) }},
  "p_subject":    {{ JSON.stringify($json.subject) }},
  "p_intent":     "OUTREACH"
}`,
    { onError: 'continueRegularOutput' },
  );

  http(
    wf,
    '✅ Mark Contacted',
    [3820, 160],
    {
      method: 'POST',
      url: "={{ $('⚙️ Config').first().json.supabase_url }}/rest/v1/rpc/sales_mark_contacted",
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'supabaseApi',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={
  "p_contact_id": {{ JSON.stringify($('🧾 Summarise Send').item.json.contact_id) }},
  "p_lead_id":    {{ JSON.stringify($('🧾 Summarise Send').item.json.lead_id) }}
}`,
      options: { timeout: 30000 },
    },
    { onError: 'continueRegularOutput' },
  );

  wait(wf, '⏳ Throttle (WhatsApp safety)', [4060, 160], "={{ 45 + Math.floor(Math.random() * 75) }}", 'seconds');

  /* ---------------- connections ---------------- */
  wf.connect('⏱ Every 6 Hours', '⚙️ Config');
  wf.connect('▶️ Manual Test', '⚙️ Config');
  wf.chain('⚙️ Config', '🎯 Search Plan', '🗺 Apify · Google Maps Scraper', '🧹 Normalise & Qualify', '❓ Any Qualified Leads?');
  wf.connect('❓ Any Qualified Leads?', '💾 Upsert Lead + Contact', 0);
  wf.connect('❓ Any Qualified Leads?', '🚪 Nothing To Do', 1);
  wf.chain('💾 Upsert Lead + Contact', '🆕 Keep Only Brand-New Leads', '🔁 One Lead At A Time');
  wf.connect('🔁 One Lead At A Time', '✅ Run Complete', 0);
  wf.connect('🔁 One Lead At A Time', '✍️ Build Copy Prompt', 1);
  wf.chain('✍️ Build Copy Prompt', '🧠 Hermes · Write Outreach', '🔎 Parse AI Copy', '🧪 Dry Run?');
  wf.connect('🧪 Dry Run?', '📋 Preview Only (no send)', 0);
  wf.connect('🧪 Dry Run?', '🔀 Route Channels', 1);
  wf.connect('📋 Preview Only (no send)', '⏳ Throttle (WhatsApp safety)');
  wf.connect('🔀 Route Channels', '📧 Gmail · Send Outreach', 0);
  wf.connect('🔀 Route Channels', '💬 WhatsApp · Send Outreach', 1);
  wf.connect('📧 Gmail · Send Outreach', '🔗 Merge Sends', 0, 0);
  wf.connect('💬 WhatsApp · Send Outreach', '🔗 Merge Sends', 0, 1);
  wf.chain('🔗 Merge Sends', '🧾 Summarise Send', '📝 Log Outbound Message', '✅ Mark Contacted', '⏳ Throttle (WhatsApp safety)');
  wf.connect('⏳ Throttle (WhatsApp safety)', '🔁 One Lead At A Time');

  /* ---------------- canvas docs ---------------- */
  wf.note(
    `## PHASE 1 · Find & contact
Runs every 6h.

**Setup**
1. Credentials: *Apify* (Header Auth \`Authorization: Bearer <APIFY_TOKEN>\`), *Supabase API*, *OpenRouter* (Header Auth \`Authorization: Bearer <KEY>\`), *SMTP*, *Evolution* (Header Auth \`apikey: <KEY>\`).
2. Edit **🎯 Search Plan** with your niches/cities.
3. Set \`DRY_RUN=true\` in n8n env for the first run — it builds the copy but sends nothing.`,
    [-480, -360],
    620,
    300,
    HEADER_COLOR,
  );

  wf.note(
    `### Only businesses with NO website
\`🧹 Normalise & Qualify\` drops anyone with a real site, keeps social-only
listings, normalises phones to international digits (no \`+\`), and caps the
batch at \`MAX_NEW_LEADS_PER_RUN\`.`,
    [420, -280],
    380,
    230,
    OK_COLOR,
  );

  wf.note(
    `### ⚠️ WhatsApp ban safety
The loop sends **one lead at a time** with a random 45–120 s pause.
Keep it under ~40 messages/day on a fresh number and warm the SIM up
for a week before scaling.`,
    [3980, -180],
    400,
    250,
    WARN_COLOR,
  );

  return wf;
}
