/**
 * WORKFLOW 3 — Prototype Generation & Razorpay Payment (Phase 3)
 *
 * Two entry points:
 *   • webhook  /build-prototype   (fired by Workflow 2)
 *   • schedule (safety net: claims any lead stuck in 'engaged')
 *
 * stage=prototype → Hermes writes HTML → deploy to Vercel → send the link
 * stage=payment   → Razorpay payment link → store → send it
 */
import {
  Workflow, V, set, code, http, noOp, merge, ifNode, switchNode,
  cond, OP, HEADER_AUTH, BASIC_AUTH, supabaseRpc, openRouter, evolutionSendText, sendEmail,
} from '../lib/n8n.mjs';
import { configNode, HEADER_COLOR, WARN_COLOR, OK_COLOR } from './common.mjs';

export default function build() {
  const wf = new Workflow('03 · Prototype Build & Razorpay Payment Link', {
    tags: ['ai-sales-machine'],
  });

  /* ---------------- triggers ---------------- */
  wf.add('🌐 Webhook · build-prototype', 'n8n-nodes-base.webhook', V.webhook, [-560, -80], {
    httpMethod: 'POST',
    path: 'build-prototype',
    responseMode: 'onReceived',
    responseCode: 202,
    options: {},
  }, { webhookId: 'c4d9b7a1-2e56-4f83-9a10-77be5c3d4f22' });

  wf.add('⏱ Safety Net (30 min)', 'n8n-nodes-base.scheduleTrigger', V.scheduleTrigger, [-560, 180], {
    rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] },
  });

  configNode(wf, [-320, 40]);

  /* ---------------- resolve work item ---------------- */
  code(
    wf,
    '🧭 Resolve Trigger',
    [-80, 40],
    `// Which door did we come through?
const isWebhook = \$('🌐 Webhook · build-prototype').isExecuted;

if (isWebhook) {
  const body = \$('🌐 Webhook · build-prototype').first().json.body ?? {};
  if (!body.lead_id) return [];
  return [{
    json: {
      mode: 'direct',
      lead_id: body.lead_id,
      contact_id: body.contact_id || null,
      stage: body.stage === 'payment' ? 'payment' : 'prototype',
    },
  }];
}

// Scheduled safety net: pick up anything Workflow 2 failed to hand over.
return [{ json: { mode: 'claim', stage: 'prototype' } }];`,
  );

  ifNode(wf, '❓ Direct Or Claim?', [160, 40], [
    cond('={{ $json.mode }}', OP.strEquals, 'direct'),
  ]);

  supabaseRpc(
    wf,
    '📇 Load Lead',
    [400, -80],
    'sales_get_lead',
    '={\n  "p_lead_id": {{ JSON.stringify($json.lead_id) }}\n}',
  );

  supabaseRpc(
    wf,
    '🎣 Claim Engaged Leads',
    [400, 180],
    'sales_claim_leads',
    `={
  "p_from_status": "engaged",
  "p_to_status":   "engaged",
  "p_limit":       3
}`,
    { onError: 'continueRegularOutput' },
  );

  merge(wf, '🔗 Merge Sources', [660, 40], 2);

  code(
    wf,
    '🧾 Normalise Lead',
    [900, 40],
    `// Both RPCs return table rows; flatten to one item per lead.
const trigger = \$('🧭 Resolve Trigger').first().json;
const out = [];

for (const item of \$input.all()) {
  const rows = Array.isArray(item.json) ? item.json : [item.json];
  for (const r of rows) {
    if (!r || !r.lead_id) continue;
    out.push({
      json: {
        lead_id: r.lead_id,
        contact_id: r.contact_id || trigger.contact_id || null,
        business_name: r.business_name || '',
        niche: r.niche || 'local business',
        location: r.location || '',
        lead_status: r.lead_status || '',
        prototype_url: r.prototype_url || '',
        contact_name: r.contact_name || 'there',
        email: r.email || '',
        phone: r.phone || '',
        channel: r.email && !r.phone ? 'email' : (r.phone ? 'whatsapp' : 'none'),
        metadata: r.metadata || {},
        // a claimed lead is always a prototype job; a webhook can ask for payment
        stage: trigger.stage === 'payment' ? 'payment' : 'prototype',
      },
    });
  }
}

// De-dupe if both the webhook and the safety net grabbed the same lead.
const seen = new Set();
return out.filter((o) => !seen.has(o.json.lead_id) && seen.add(o.json.lead_id));`,
  );

  switchNode(wf, '🔀 Prototype Or Payment?', [1140, 40], [
    {
      key: 'prototype',
      conditions: [
        cond('={{ $json.stage }}', OP.strEquals, 'prototype'),
        cond('={{ $json.prototype_url }}', OP.strEmpty),
      ],
    },
    { key: 'payment', conditions: [cond('={{ $json.stage }}', OP.strEquals, 'payment')] },
  ], { fallbackOutput: 'extra' });

  noOp(wf, '⏭ Already Has Prototype', [1400, 320]);

  /* ================= PROTOTYPE BRANCH ================= */
  set(wf, '🎨 Build Site Prompt', [1400, -220], [
    {
      name: 'system_prompt',
      value:
        '=You are a senior front-end developer. You output a single complete HTML document and absolutely nothing else — no markdown fences, no commentary before or after.',
    },
    {
      name: 'prompt',
      value: `=Build a one-page marketing website for this real local business.

Business: {{ $json.business_name }}
Industry: {{ $json.niche }}
City: {{ $json.location }}
Phone: {{ $json.phone }}
Address: {{ $json.metadata?.address || $json.location }}
Google rating: {{ $json.metadata?.rating || 'n/a' }} from {{ $json.metadata?.reviews || 0 }} reviews

Requirements:
- Single self-contained index.html. Tailwind via <script src="https://cdn.tailwindcss.com"></script>.
- Sections: sticky nav, hero with a strong headline + "Call now" button (tel: link to the phone above), 3-4 services cards relevant to a {{ $json.niche }}, why-choose-us with the Google rating if present, testimonials (mark them clearly as sample text), contact section with phone/address and a simple form (no backend, just markup), footer.
- Real, specific copy for a {{ $json.niche }} in {{ $json.location }}. No lorem ipsum. No placeholder like [Business Name].
- Modern look: one accent colour that suits the industry, generous whitespace, rounded cards, subtle shadows, mobile-first responsive.
- Use inline SVG icons or emoji — never link to image files that don't exist.
- Include <title> and a meta description with the business name and city.
- No external JS besides the Tailwind CDN.

Output the raw HTML document starting with <!DOCTYPE html>.`,
    },
  ]);

  openRouter(wf, '🧠 Hermes · Generate HTML', [1640, -220], {
    model: "$('⚙️ Config').first().json.model_coder",
    maxTokens: 8000,
    temperature: 0.6,
  }, { onError: 'continueRegularOutput' });

  code(
    wf,
    '🧽 Extract & Validate HTML',
    [1880, -220],
    `const lead = \$('🎨 Build Site Prompt').item.json;
const ctx  = \$('🧾 Normalise Lead').item.json;

let html = (\$json?.choices?.[0]?.message?.content || '').trim();

// strip markdown fences if the model added them anyway
html = html.replace(/^\\\`\\\`\\\`(?:html)?\\s*/i, '').replace(/\\\`\\\`\\\`\\s*\$/, '').trim();

// keep only the document itself
const start = html.search(/<!DOCTYPE|<html/i);
if (start > 0) html = html.slice(start);
const end = html.toLowerCase().lastIndexOf('</html>');
if (end !== -1) html = html.slice(0, end + 7);

const looksValid =
  html.length > 800 &&
  /<html[\\s>]/i.test(html) &&
  /<\\/html>/i.test(html) &&
  !/\\[business name\\]|lorem ipsum/i.test(html);

if (!looksValid) {
  throw new Error(
    \`Generated HTML failed validation for "\${ctx.business_name}" (length \${html.length}). \` +
    'Try a stronger model in OPENROUTER_MODEL_CODER.'
  );
}

// Vercel wants a plain UTF-8 string; slug keeps the project name legal.
const slug = (ctx.business_name || 'lead')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-\$/g, '').slice(0, 40) || 'lead';

return [{
  json: {
    ...ctx,
    html,
    html_bytes: Buffer.byteLength(html, 'utf8'),
    project_name: \`proto-\${slug}-\${String(ctx.lead_id).slice(0, 8)}\`,
  },
}];`,
  );

  http(
    wf,
    '▲ Deploy To Vercel',
    [2120, -220],
    {
      method: 'POST',
      url: 'https://api.vercel.com/v13/deployments',
      ...HEADER_AUTH,
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'forceNew', value: '1' }] },
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={
  "name": {{ JSON.stringify($json.project_name) }},
  "target": "production",
  "public": true,
  "files": [
    {
      "file": "index.html",
      "data": {{ JSON.stringify($json.html) }},
      "encoding": "utf-8"
    }
  ],
  "projectSettings": {
    "framework": null,
    "buildCommand": null,
    "outputDirectory": null,
    "installCommand": null
  }
}`,
      options: { timeout: 120000 },
    },
    { retryOnFail: true, maxTries: 2, waitBetweenTries: 5000 },
  );

  code(
    wf,
    '🔗 Prototype URL',
    [2360, -220],
    `const ctx = \$('🧽 Extract & Validate HTML').item.json;
const d = \$json || {};

// v13 returns { url: "proto-x-123.vercel.app" } (no scheme) plus alias[]
const host = d.alias?.[0] || d.url || d.deployment?.url;
if (!host) throw new Error('Vercel did not return a deployment URL: ' + JSON.stringify(d).slice(0, 400));

const url = host.startsWith('http') ? host : \`https://\${host}\`;

return [{ json: { ...ctx, prototype_url: url, deployment_id: d.id || null } }];`,
  );

  supabaseRpc(
    wf,
    '💾 Save Prototype URL',
    [2600, -220],
    'sales_set_prototype',
    `={
  "p_lead_id": {{ JSON.stringify($json.lead_id) }},
  "p_url":     {{ JSON.stringify($json.prototype_url) }}
}`,
  );

  code(
    wf,
    '💌 Compose Prototype Message',
    [2840, -220],
    `const ctx = \$('🔗 Prototype URL').item.json;
const cfg = \$('⚙️ Config').first().json;
const name = ctx.contact_name && ctx.contact_name !== 'Owner' ? ctx.contact_name : 'there';

const email_body =
\`Hi \${name},

Here's the free mockup I put together for \${ctx.business_name}:

\${ctx.prototype_url}

It's a live page — open it on your phone too. Everything on it (colours, photos, wording, your services) can be changed.

If you like the direction, I can have the finished site live on your own domain within 48 hours. If not, no hard feelings — the mockup is yours to keep either way.

What do you think?

\${cfg.sender_name}\`;

const whatsapp_body =
\`Hi \${name}, the free mockup for \${ctx.business_name} is ready 👇

\${ctx.prototype_url}

Have a look (works on mobile too) — everything can be changed. What do you think?\`;

return [{
  json: {
    ...ctx,
    subject: \`Your free mockup — \${ctx.business_name}\`,
    email_body,
    whatsapp_body,
    stage_label: 'PROTOTYPE',
  },
}];`,
  );

  /* ================= PAYMENT BRANCH ================= */
  code(
    wf,
    '🧮 Payment Payload',
    [1400, 100],
    `const ctx = \$json;
const cfg = \$('⚙️ Config').first().json;

const amount = Number(cfg.price_paise || 150000);
if (!Number.isFinite(amount) || amount < 100) {
  throw new Error('OFFER_PRICE_PAISE must be an integer >= 100 (amount is in paise)');
}

// Razorpay rejects malformed contacts — only send what we actually have.
const customer = { name: (ctx.contact_name || 'Customer').slice(0, 50) };
if (ctx.email) customer.email = ctx.email;
if (ctx.phone) customer.contact = '+' + String(ctx.phone).replace(/\\D/g, '');

return [{
  json: {
    ...ctx,
    amount,
    currency: cfg.currency || 'INR',
    customer,
    reference_id: \`lead_\${String(ctx.lead_id).slice(0, 8)}_\${Date.now().toString(36)}\`,
    description: \`Website development — \${ctx.business_name}\`.slice(0, 250),
    expire_by: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  },
}];`,
  );

  http(
    wf,
    '💳 Razorpay · Create Payment Link',
    [1640, 100],
    {
      method: 'POST',
      url: 'https://api.razorpay.com/v1/payment_links',
      ...BASIC_AUTH,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={
  "amount": {{ $json.amount }},
  "currency": {{ JSON.stringify($json.currency) }},
  "accept_partial": false,
  "description": {{ JSON.stringify($json.description) }},
  "reference_id": {{ JSON.stringify($json.reference_id) }},
  "customer": {{ JSON.stringify($json.customer) }},
  "notify": { "sms": {{ Boolean($json.phone) }}, "email": {{ Boolean($json.email) }} },
  "reminder_enable": true,
  "expire_by": {{ $json.expire_by }},
  "notes": {
    "lead_id": {{ JSON.stringify($json.lead_id) }},
    "contact_id": {{ JSON.stringify($json.contact_id || '') }},
    "business_name": {{ JSON.stringify($json.business_name) }}
  },
  "callback_method": "get"
}`,
      options: { timeout: 60000 },
    },
    { retryOnFail: true, maxTries: 2, waitBetweenTries: 4000 },
  );

  code(
    wf,
    '🧷 Capture Link',
    [1880, 100],
    `const ctx = \$('🧮 Payment Payload').item.json;
const r = \$json || {};

if (!r.id || !r.short_url) {
  throw new Error('Razorpay response missing id/short_url: ' + JSON.stringify(r).slice(0, 400));
}

return [{
  json: {
    ...ctx,
    razorpay_link_id: r.id,
    payment_url: r.short_url,
    amount_display: (Number(r.amount || ctx.amount) / 100).toLocaleString('en-IN'),
  },
}];`,
  );

  supabaseRpc(
    wf,
    '💾 Store Payment Record',
    [2120, 100],
    'sales_create_payment',
    `={
  "p_lead_id":    {{ JSON.stringify($json.lead_id) }},
  "p_contact_id": {{ JSON.stringify($json.contact_id) }},
  "p_link_id":    {{ JSON.stringify($json.razorpay_link_id) }},
  "p_amount":     {{ $json.amount }},
  "p_currency":   {{ JSON.stringify($json.currency) }},
  "p_url":        {{ JSON.stringify($json.payment_url) }}
}`,
  );

  code(
    wf,
    '💌 Compose Payment Message',
    [2360, 100],
    `const ctx = \$('🧷 Capture Link').item.json;
const cfg = \$('⚙️ Config').first().json;
const name = ctx.contact_name && ctx.contact_name !== 'Owner' ? ctx.contact_name : 'there';
const price = \`\${ctx.currency === 'INR' ? '₹' : ctx.currency + ' '}\${ctx.amount_display}\`;

const email_body =
\`Hi \${name},

Brilliant — let's get \${ctx.business_name} online properly.

Here's your secure payment link (\${price}, one-off):
\${ctx.payment_url}

What happens next:
1. You pay through the link above (UPI, card or netbanking).
2. I build the full site and put it live within 48 hours.
3. You get the link plus everything needed to hand it to anyone later.

The link is valid for 7 days. Shout if you'd like anything changed before we start.

\${cfg.sender_name}\`;

const whatsapp_body =
\`Great! Here's your secure payment link for \${ctx.business_name} (\${price} one-off):

\${ctx.payment_url}

Once it's paid I'll have the full site live within 48 hours 🚀\`;

return [{
  json: {
    ...ctx,
    prototype_url: ctx.prototype_url || '',
    subject: \`Payment link — \${ctx.business_name} website\`,
    email_body,
    whatsapp_body,
    stage_label: 'PAYMENT_LINK',
  },
}];`,
  );

  /* ================= SHARED SEND ================= */
  merge(wf, '🔗 Merge Messages', [3100, -60], 2);

  switchNode(wf, '🔀 Send Channel', [3340, -60], [
    { key: 'email', conditions: [cond('={{ $json.email }}', OP.strNotEmpty)] },
    { key: 'whatsapp', conditions: [cond('={{ $json.phone }}', OP.strNotEmpty)] },
  ], { allMatchingOutputs: true });

  sendEmail(wf, '📧 Send Email', [3580, -160], {
    toExpr: '{{ $json.email }}',
    subjectExpr: '{{ $json.subject }}',
    textExpr: '{{ $json.email_body }}',
  });

  evolutionSendText(wf, '💬 Send WhatsApp', [3580, 40], {
    numberExpr: '$json.phone',
    textExpr: '$json.whatsapp_body',
  });

  merge(wf, '🔗 Merge Sends', [3820, -60], 2);

  supabaseRpc(
    wf,
    '📝 Log Outbound',
    [4060, -60],
    'sales_log_message',
    `={
  "p_lead_id":    {{ JSON.stringify($('🔗 Merge Messages').first().json.lead_id) }},
  "p_contact_id": {{ JSON.stringify($('🔗 Merge Messages').first().json.contact_id) }},
  "p_direction":  "outbound",
  "p_channel":    {{ JSON.stringify($('🔗 Merge Messages').first().json.channel) }},
  "p_body":       {{ JSON.stringify($('🔗 Merge Messages').first().json.email_body) }},
  "p_subject":    {{ JSON.stringify($('🔗 Merge Messages').first().json.subject) }},
  "p_intent":     {{ JSON.stringify($('🔗 Merge Messages').first().json.stage_label) }}
}`,
    { onError: 'continueRegularOutput' },
  );

  /* ---------------- connections ---------------- */
  wf.connect('🌐 Webhook · build-prototype', '⚙️ Config');
  wf.connect('⏱ Safety Net (30 min)', '⚙️ Config');
  wf.chain('⚙️ Config', '🧭 Resolve Trigger', '❓ Direct Or Claim?');
  wf.connect('❓ Direct Or Claim?', '📇 Load Lead', 0);
  wf.connect('❓ Direct Or Claim?', '🎣 Claim Engaged Leads', 1);
  wf.connect('📇 Load Lead', '🔗 Merge Sources', 0, 0);
  wf.connect('🎣 Claim Engaged Leads', '🔗 Merge Sources', 0, 1);
  wf.chain('🔗 Merge Sources', '🧾 Normalise Lead', '🔀 Prototype Or Payment?');

  wf.connect('🔀 Prototype Or Payment?', '🎨 Build Site Prompt', 0);
  wf.connect('🔀 Prototype Or Payment?', '🧮 Payment Payload', 1);
  wf.connect('🔀 Prototype Or Payment?', '⏭ Already Has Prototype', 2);

  wf.chain('🎨 Build Site Prompt', '🧠 Hermes · Generate HTML', '🧽 Extract & Validate HTML',
    '▲ Deploy To Vercel', '🔗 Prototype URL', '💾 Save Prototype URL', '💌 Compose Prototype Message');
  wf.chain('🧮 Payment Payload', '💳 Razorpay · Create Payment Link', '🧷 Capture Link',
    '💾 Store Payment Record', '💌 Compose Payment Message');

  wf.connect('💌 Compose Prototype Message', '🔗 Merge Messages', 0, 0);
  wf.connect('💌 Compose Payment Message', '🔗 Merge Messages', 0, 1);
  wf.connect('🔗 Merge Messages', '🔀 Send Channel');
  wf.connect('🔀 Send Channel', '📧 Send Email', 0);
  wf.connect('🔀 Send Channel', '💬 Send WhatsApp', 1);
  wf.connect('📧 Send Email', '🔗 Merge Sends', 0, 0);
  wf.connect('💬 Send WhatsApp', '🔗 Merge Sends', 0, 1);
  wf.connect('🔗 Merge Sends', '📝 Log Outbound');

  /* ---------------- canvas docs ---------------- */
  wf.note(
    `## PHASE 3 · Build & bill
**Prototype path** – Hermes writes a full one-page site, it goes live on
Vercel, the link is sent, lead → \`prototype_sent\`.

**Payment path** – triggered when Workflow 2 classifies a reply as
\`APPROVED\`. Creates a Razorpay link, stores it, sends it, lead →
\`payment_sent\`.

The 30-min schedule is only a safety net for leads whose webhook handoff
failed — \`sales_claim_leads\` uses \`FOR UPDATE SKIP LOCKED\` so it can
never double-build.`,
    [-600, -560],
    620,
    380,
    HEADER_COLOR,
  );

  wf.note(
    `### Free models & big HTML
A full page is ~6-8k tokens. Free models often truncate — that's what
**🧽 Extract & Validate HTML** catches (it throws instead of deploying a
broken page). If it fires often, point \`OPENROUTER_MODEL_CODER\` at a
paid model; it's a few cents per site.`,
    [1820, -560],
    420,
    260,
    WARN_COLOR,
  );

  wf.note(
    `### Amount is in **paise**
\`OFFER_PRICE_PAISE=150000\` → ₹1,500.
Use Razorpay **test mode** keys until you've seen the whole flow work end
to end.`,
    [1600, 320],
    400,
    180,
    OK_COLOR,
  );

  return wf;
}
