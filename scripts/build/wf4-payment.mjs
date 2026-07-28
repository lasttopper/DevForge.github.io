/**
 * WORKFLOW 4 — Razorpay Webhook, Full Build & Delivery (Phase 4)
 *
 * Razorpay webhook → HMAC signature verification → idempotent DB update →
 * Hermes builds the full multi-section site → Vercel → deliver + notify you.
 */
import {
  Workflow, V, set, code, http, noOp, merge, ifNode, switchNode,
  cond, OP, HEADER_AUTH, supabaseRpc, openRouter, evolutionSendText, sendEmail,
} from '../lib/n8n.mjs';
import { configNode, HEADER_COLOR, WARN_COLOR, OK_COLOR } from './common.mjs';

export default function build() {
  const wf = new Workflow('04 · Razorpay Webhook, Full Build & Delivery', {
    tags: ['ai-sales-machine'],
  });

  /* ---------------- webhook ---------------- */
  wf.add('🌐 Webhook · razorpay', 'n8n-nodes-base.webhook', V.webhook, [-620, 0], {
    httpMethod: 'POST',
    path: 'razorpay-webhook',
    responseMode: 'responseNode',
    options: { rawBody: true },
  }, { webhookId: 'e81a5f30-6c72-4b19-9d84-1f0ac6b52d77' });

  configNode(wf, [-380, 0]);

  /* ---------------- signature verification ---------------- */
  code(
    wf,
    '🔐 Verify Razorpay Signature',
    [-140, 0],
    `// Razorpay signs the RAW body with your webhook secret (HMAC-SHA256).
// The webhook node must have "Raw Body" ON, otherwise the bytes change and
// the signature will never match.
const crypto = require('crypto');

const hook   = \$('🌐 Webhook · razorpay').first().json;
const secret = \$env.RAZORPAY_WEBHOOK_SECRET || '';

const headers   = hook.headers || {};
const signature = headers['x-razorpay-signature'] || headers['X-Razorpay-Signature'] || '';

// rawBody arrives base64-encoded in .body when rawBody=true
let raw = hook.body;
if (raw && typeof raw === 'object' && raw.data) raw = raw.data;
const rawString = Buffer.isBuffer(raw)
  ? raw.toString('utf8')
  : (typeof raw === 'string'
      ? (/^[A-Za-z0-9+/=]+\$/.test(raw) && raw.length % 4 === 0
          ? Buffer.from(raw, 'base64').toString('utf8')
          : raw)
      : JSON.stringify(raw ?? {}));

let payload;
try { payload = JSON.parse(rawString); }
catch { throw new Error('Webhook body is not JSON. Enable "Raw Body" on the Webhook node.'); }

let valid = false;
if (secret && signature) {
  const expected = crypto.createHmac('sha256', secret).update(rawString).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  valid = a.length === b.length && crypto.timingSafeEqual(a, b);
}

if (!secret) {
  // Loud, but don't hard-fail in test mode — you'd never see why nothing works.
  console.warn('RAZORPAY_WEBHOOK_SECRET is not set — signature NOT verified.');
}

const entity = payload?.payload?.payment_link?.entity
            || payload?.payload?.payment?.entity
            || {};
const paymentEntity = payload?.payload?.payment?.entity || {};

return [{
  json: {
    valid: valid || !secret,
    strict_valid: valid,
    event: payload?.event || '',
    link_id: entity.id || paymentEntity.invoice_id || '',
    lead_id: entity.notes?.lead_id || paymentEntity.notes?.lead_id || '',
    razorpay_payment_id: paymentEntity.id || entity.payment_id || null,
    amount: Number(entity.amount ?? paymentEntity.amount ?? 0),
    is_paid_event: ['payment_link.paid', 'payment.captured'].includes(payload?.event),
  },
}];`,
  );

  ifNode(wf, '❓ Valid & Paid?', [100, 0], [
    cond('={{ $json.valid }}', OP.boolTrue),
    cond('={{ $json.is_paid_event }}', OP.boolTrue),
  ]);

  wf.add('↩️ 200 OK (ignored)', 'n8n-nodes-base.respondToWebhook', V.respondToWebhook, [340, 180], {
    respondWith: 'json',
    responseBody: '={{ JSON.stringify({ ok: true, ignored: true, reason: $json.valid ? "not a paid event" : "bad signature" }) }}',
    options: { responseCode: 200 },
  });

  wf.add('↩️ 200 OK (accepted)', 'n8n-nodes-base.respondToWebhook', V.respondToWebhook, [340, -160], {
    respondWith: 'json',
    responseBody: '={{ JSON.stringify({ ok: true, accepted: true }) }}',
    options: { responseCode: 200 },
  });

  /* ---------------- record the payment ---------------- */
  supabaseRpc(
    wf,
    '💰 Mark Payment Paid',
    [580, -160],
    'sales_record_payment_paid',
    `={
  "p_link_id":    {{ JSON.stringify($('🔐 Verify Razorpay Signature').first().json.link_id) }},
  "p_payment_id": {{ JSON.stringify($('🔐 Verify Razorpay Signature').first().json.razorpay_payment_id) }},
  "p_amount":     {{ $('🔐 Verify Razorpay Signature').first().json.amount }}
}`,
  );

  code(
    wf,
    '🧾 Payment Context',
    [820, -160],
    `const sig  = \$('🔐 Verify Razorpay Signature').first().json;
const rows = Array.isArray(\$json) ? \$json : (\$json ? [\$json] : []);
const row  = rows.find((r) => r && r.lead_id) || null;

if (!row) {
  throw new Error(
    \`Payment link \${sig.link_id} is not in the payments table. \` +
    'Either it was created outside this system, or Workflow 3 failed to store it.'
  );
}

if (row.already_paid) {
  // Razorpay retries webhooks; the RPC is idempotent so just stop here.
  return [{ json: { ...row, skip: true, reason: 'duplicate webhook' } }];
}

return [{
  json: {
    ...row,
    skip: false,
    razorpay_payment_id: sig.razorpay_payment_id,
    amount_display: (Number(row.amount || sig.amount) / 100).toLocaleString('en-IN'),
    contact_name: row.contact_name || 'there',
  },
}];`,
  );

  ifNode(wf, '❓ First Time Paid?', [1060, -160], [cond('={{ $json.skip }}', OP.boolFalse)]);
  noOp(wf, '🔁 Duplicate Webhook', [1300, 20]);

  /* ---------------- instant alert to you ---------------- */
  http(
    wf,
    '🔔 Alert Me (Slack/Discord)',
    [1300, -340],
    {
      method: 'POST',
      url: "={{ $('⚙️ Config').first().json.alert_channel_url }}",
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={
  "content": {{ JSON.stringify('💰 PAYMENT RECEIVED — ' + $json.business_name + ' (' + ($json.niche || '') + ', ' + ($json.location || '') + ')\\nAmount: ' + $json.amount_display + '\\nContact: ' + ($json.email || '') + ' ' + ($json.phone || '') + '\\nPrototype: ' + ($json.prototype_url || 'n/a') + '\\nBuilding the full site now…') }},
  "text": {{ JSON.stringify('💰 PAYMENT RECEIVED — ' + $json.business_name + ' | ' + $json.amount_display + ' | ' + ($json.email || $json.phone || '')) }}
}`,
      options: { timeout: 15000 },
    },
    { onError: 'continueRegularOutput', alwaysOutputData: true },
  );

  /* ---------------- receipt to the customer ---------------- */
  code(
    wf,
    '💌 Compose Receipt',
    [1300, -160],
    `const ctx = \$json;
const cfg = \$('⚙️ Config').first().json;
const name = ctx.contact_name && ctx.contact_name !== 'Owner' ? ctx.contact_name : 'there';

return [{
  json: {
    ...ctx,
    subject: \`Payment received — building \${ctx.business_name}\`,
    email_body:
\`Hi \${name},

Payment received, thank you! 🎉

I'm starting on the full site for \${ctx.business_name} right now. You'll have the live link within 48 hours, and I'll send it to you here.

If there's anything you want changed from the mockup — wording, colours, services, opening hours — just reply to this message and I'll fold it in before launch.

\${cfg.sender_name}\`,
    whatsapp_body:
\`Payment received, thank you! 🎉 I'm building the full site for \${ctx.business_name} now — you'll have the live link within 48 hours. Anything you want changed from the mockup, just tell me here.\`,
    stage_label: 'RECEIPT',
  },
}];`,
  );

  switchNode(wf, '🔀 Receipt Channel', [1540, -160], [
    { key: 'email', conditions: [cond('={{ $json.email }}', OP.strNotEmpty)] },
    { key: 'whatsapp', conditions: [cond('={{ $json.phone }}', OP.strNotEmpty)] },
  ], { allMatchingOutputs: true });

  sendEmail(wf, '📧 Send Receipt', [1780, -240], {
    toExpr: '{{ $json.email }}',
    subjectExpr: '{{ $json.subject }}',
    textExpr: '{{ $json.email_body }}',
  });

  evolutionSendText(wf, '💬 Send Receipt (WA)', [1780, -80], {
    numberExpr: '$json.phone',
    textExpr: '$json.whatsapp_body',
  });

  merge(wf, '🔗 Merge Receipt', [2020, -160], 2);

  /* ---------------- build mode ---------------- */
  code(
    wf,
    '🛠 Choose Build Mode',
    [2260, -160],
    `// BUILD_MODE=auto   → Hermes builds the full site and deploys to Vercel
// BUILD_MODE=manual → you build it; the workflow just notifies you
const ctx  = \$('💌 Compose Receipt').first().json;
const mode = (\$env.BUILD_MODE || 'auto').toLowerCase() === 'manual' ? 'manual' : 'auto';
return [{ json: { ...ctx, build_mode: mode } }];`,
  );

  ifNode(wf, '❓ Auto Build?', [2500, -160], [
    cond('={{ $json.build_mode }}', OP.strEquals, 'auto'),
  ]);

  noOp(wf, '🙋 Manual Build Queue', [2740, 40]);

  set(wf, '🏗 Build Full Site Prompt', [2740, -280], [
    {
      name: 'system_prompt',
      value:
        '=You are a senior front-end developer shipping a paid client website. You output one complete, production-ready HTML document and nothing else — no markdown fences, no commentary.',
    },
    {
      name: 'prompt',
      value: `=Build the FULL production website for a paying client. This replaces the free mockup, so it must be noticeably richer than a one-screen landing page.

Business: {{ $json.business_name }}
Industry: {{ $json.niche }}
City: {{ $json.location }}
Phone: {{ $json.phone }}
Email: {{ $json.email }}
Approved mockup (match its spirit, then go further): {{ $json.prototype_url }}

Requirements:
- Single self-contained index.html, Tailwind via <script src="https://cdn.tailwindcss.com"></script>.
- Sections in order: sticky nav with smooth-scroll anchors, hero with tel: call button, about, 6 detailed service cards with realistic pricing ranges for a {{ $json.niche }} in {{ $json.location }}, process/how-it-works in 3 steps, why-choose-us, 3 testimonials, FAQ with 5 questions using <details>/<summary>, service-area, contact section with click-to-call and click-to-WhatsApp (https://wa.me/{{ $json.phone }}), footer with opening hours.
- Full SEO head: <title>, meta description, canonical, Open Graph tags, and a JSON-LD LocalBusiness schema block with the real name, phone and city.
- Accessible: semantic landmarks, alt text, visible focus states, colour contrast AA.
- Mobile-first responsive, one tasteful accent colour for the industry, inline SVG icons only.
- Real specific copy throughout. No lorem ipsum, no [placeholders], no broken image links.

Output the raw HTML document starting with <!DOCTYPE html>.`,
    },
  ]);

  openRouter(wf, '🧠 Hermes · Build Full Site', [2980, -280], {
    model: "$('⚙️ Config').first().json.model_coder",
    maxTokens: 16000,
    temperature: 0.6,
  }, { onError: 'continueRegularOutput' });

  code(
    wf,
    '🧽 Validate Full Site',
    [3220, -280],
    `const ctx = \$('🛠 Choose Build Mode').first().json;

let html = (\$json?.choices?.[0]?.message?.content || '').trim();
html = html.replace(/^\\\`\\\`\\\`(?:html)?\\s*/i, '').replace(/\\\`\\\`\\\`\\s*\$/, '').trim();

const start = html.search(/<!DOCTYPE|<html/i);
if (start > 0) html = html.slice(start);
const end = html.toLowerCase().lastIndexOf('</html>');
if (end !== -1) html = html.slice(0, end + 7);

const problems = [];
if (html.length < 3000) problems.push('too short (' + html.length + ' chars)');
if (!/<\\/html>/i.test(html)) problems.push('no closing </html> — model truncated');
if (/lorem ipsum|\\[business name\\]|\\[phone\\]/i.test(html)) problems.push('placeholder text left in');

if (problems.length) {
  // A paying customer is waiting — fail loudly so the error workflow pings you.
  throw new Error(
    \`Full-site build rejected for "\${ctx.business_name}": \${problems.join('; ')}. \` +
    'PAYMENT IS ALREADY TAKEN — build this one manually.'
  );
}

const slug = (ctx.business_name || 'client')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-\$/g, '').slice(0, 40) || 'client';

return [{ json: { ...ctx, html, project_name: \`\${slug}-\${String(ctx.lead_id).slice(0, 8)}\` } }];`,
  );

  http(
    wf,
    '▲ Deploy Final Site',
    [3460, -280],
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
    { "file": "index.html", "data": {{ JSON.stringify($json.html) }}, "encoding": "utf-8" }
  ],
  "projectSettings": { "framework": null, "buildCommand": null, "outputDirectory": null, "installCommand": null }
}`,
      options: { timeout: 180000 },
    },
    { retryOnFail: true, maxTries: 2, waitBetweenTries: 8000 },
  );

  code(
    wf,
    '🔗 Final URL',
    [3700, -280],
    `const ctx = \$('🧽 Validate Full Site').first().json;
const d = \$json || {};
const host = d.alias?.[0] || d.url || d.deployment?.url;
if (!host) throw new Error('Vercel returned no URL: ' + JSON.stringify(d).slice(0, 400));
return [{ json: { ...ctx, final_url: host.startsWith('http') ? host : \`https://\${host}\` } }];`,
  );

  supabaseRpc(
    wf,
    '🏁 Mark Delivered',
    [3940, -280],
    'sales_mark_delivered',
    `={
  "p_lead_id": {{ JSON.stringify($json.lead_id) }},
  "p_url":     {{ JSON.stringify($json.final_url) }}
}`,
  );

  code(
    wf,
    '💌 Compose Delivery',
    [4180, -280],
    `const ctx = \$('🔗 Final URL').first().json;
const cfg = \$('⚙️ Config').first().json;
const name = ctx.contact_name && ctx.contact_name !== 'Owner' ? ctx.contact_name : 'there';

return [{
  json: {
    ...ctx,
    subject: \`\${ctx.business_name} is live 🎉\`,
    email_body:
\`Hi \${name},

Your website is live:

\${ctx.final_url}

Everything works on mobile — the call button dials your number and the WhatsApp button opens a chat with you directly.

Two things worth doing next:
1. Send me your preferred domain (e.g. \${(ctx.business_name || 'yourbusiness').toLowerCase().replace(/[^a-z0-9]+/g, '')}.com) and I'll point it at the site.
2. Add the link to your Google Business Profile — that's where most of your customers will find it.

Any tweaks at all, just reply here.

\${cfg.sender_name}\`,
    whatsapp_body:
\`\${ctx.business_name} is live 🎉

\${ctx.final_url}

Open it on your phone — the call and WhatsApp buttons go straight to you. Send me the domain you want and I'll connect it. Any tweaks, just message me here.\`,
    stage_label: 'DELIVERY',
  },
}];`,
  );

  switchNode(wf, '🔀 Delivery Channel', [4420, -280], [
    { key: 'email', conditions: [cond('={{ $json.email }}', OP.strNotEmpty)] },
    { key: 'whatsapp', conditions: [cond('={{ $json.phone }}', OP.strNotEmpty)] },
  ], { allMatchingOutputs: true });

  sendEmail(wf, '📧 Deliver By Email', [4660, -360], {
    toExpr: '{{ $json.email }}',
    subjectExpr: '{{ $json.subject }}',
    textExpr: '{{ $json.email_body }}',
  });

  evolutionSendText(wf, '💬 Deliver By WhatsApp', [4660, -200], {
    numberExpr: '$json.phone',
    textExpr: '$json.whatsapp_body',
  });

  merge(wf, '🔗 Merge Delivery', [4900, -280], 2);

  supabaseRpc(
    wf,
    '📝 Log Delivery',
    [5140, -280],
    'sales_log_message',
    `={
  "p_lead_id":    {{ JSON.stringify($('💌 Compose Delivery').first().json.lead_id) }},
  "p_contact_id": null,
  "p_direction":  "outbound",
  "p_channel":    "email",
  "p_body":       {{ JSON.stringify($('💌 Compose Delivery').first().json.email_body) }},
  "p_subject":    {{ JSON.stringify($('💌 Compose Delivery').first().json.subject) }},
  "p_intent":     "DELIVERY"
}`,
    { onError: 'continueRegularOutput' },
  );

  /* ---------------- connections ---------------- */
  wf.chain('🌐 Webhook · razorpay', '⚙️ Config', '🔐 Verify Razorpay Signature', '❓ Valid & Paid?');
  wf.connect('❓ Valid & Paid?', '↩️ 200 OK (accepted)', 0);
  wf.connect('❓ Valid & Paid?', '↩️ 200 OK (ignored)', 1);
  wf.chain('↩️ 200 OK (accepted)', '💰 Mark Payment Paid', '🧾 Payment Context', '❓ First Time Paid?');
  wf.connect('❓ First Time Paid?', '💌 Compose Receipt', 0);
  wf.connect('❓ First Time Paid?', '🔔 Alert Me (Slack/Discord)', 0);
  wf.connect('❓ First Time Paid?', '🔁 Duplicate Webhook', 1);
  wf.connect('💌 Compose Receipt', '🔀 Receipt Channel');
  wf.connect('🔀 Receipt Channel', '📧 Send Receipt', 0);
  wf.connect('🔀 Receipt Channel', '💬 Send Receipt (WA)', 1);
  wf.connect('📧 Send Receipt', '🔗 Merge Receipt', 0, 0);
  wf.connect('💬 Send Receipt (WA)', '🔗 Merge Receipt', 0, 1);
  wf.chain('🔗 Merge Receipt', '🛠 Choose Build Mode', '❓ Auto Build?');
  wf.connect('❓ Auto Build?', '🏗 Build Full Site Prompt', 0);
  wf.connect('❓ Auto Build?', '🙋 Manual Build Queue', 1);
  wf.chain('🏗 Build Full Site Prompt', '🧠 Hermes · Build Full Site', '🧽 Validate Full Site',
    '▲ Deploy Final Site', '🔗 Final URL', '🏁 Mark Delivered', '💌 Compose Delivery', '🔀 Delivery Channel');
  wf.connect('🔀 Delivery Channel', '📧 Deliver By Email', 0);
  wf.connect('🔀 Delivery Channel', '💬 Deliver By WhatsApp', 1);
  wf.connect('📧 Deliver By Email', '🔗 Merge Delivery', 0, 0);
  wf.connect('💬 Deliver By WhatsApp', '🔗 Merge Delivery', 0, 1);
  wf.connect('🔗 Merge Delivery', '📝 Log Delivery');

  /* ---------------- canvas docs ---------------- */
  wf.note(
    `## PHASE 4 · Money in, site out
**Razorpay setup:** Dashboard → Settings → Webhooks → add
\`https://YOUR-N8N/webhook/razorpay-webhook\`, events
\`payment_link.paid\` + \`payment.captured\`, and put the secret in
\`RAZORPAY_WEBHOOK_SECRET\`.

⚠️ The Webhook node has **Raw Body ON** — required for HMAC to match.
Don't switch it off.`,
    [-660, -420],
    620,
    320,
    HEADER_COLOR,
  );

  wf.note(
    `### Idempotent by design
Razorpay retries webhooks for up to 24h. \`sales_record_payment_paid\`
returns \`already_paid\` so a replay stops at **🔁 Duplicate Webhook** —
the customer never gets two receipts.`,
    [1060, 200],
    420,
    200,
    OK_COLOR,
  );

  wf.note(
    `### BUILD_MODE
\`auto\` (default) — Hermes builds and deploys the full site.
\`manual\` — you get the alert and build it yourself; the receipt still
goes out automatically.

If the auto build fails validation the node **throws on purpose**: money
is already taken, so you want a loud error, not a silent bad deploy.
Wire an Error Workflow to catch it.`,
    [2700, 200],
    460,
    300,
    WARN_COLOR,
  );

  return wf;
}
