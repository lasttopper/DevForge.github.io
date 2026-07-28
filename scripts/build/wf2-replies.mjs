/**
 * WORKFLOW 2 — Unified Reply Listener & Lead Lock (Phase 2)
 *
 * IMAP + Evolution webhook → normalise into one shape → resolve the contact →
 * Hermes triages the intent → lock the lead / answer the question / mark lost.
 */
import {
  Workflow, V, set, code, http, noOp, merge, ifNode, switchNode,
  cond, OP, supabaseRpc, openRouter, evolutionSendText, sendEmail,
} from '../lib/n8n.mjs';
import { configNode, HEADER_COLOR, WARN_COLOR, OK_COLOR } from './common.mjs';

export default function build() {
  const wf = new Workflow('02 · Unified Reply Listener & Lead Lock', {
    tags: ['ai-sales-machine'],
  });

  /* ---------------- triggers ---------------- */
  wf.add('📥 IMAP · Email Replies', 'n8n-nodes-base.emailReadImap', V.emailReadImap, [-520, -120], {
    postProcessAction: 'read',
    format: 'simple',
    options: { allowUnauthorizedCerts: false, forceReconnect: 60 },
  });

  wf.add('🌐 Webhook · WhatsApp Replies', 'n8n-nodes-base.webhook', V.webhook, [-520, 120], {
    httpMethod: 'POST',
    path: 'whatsapp-reply',
    responseMode: 'onReceived',
    responseCode: 200,
    options: { rawBody: false },
  }, { webhookId: 'a7f3c1e2-9b44-4c0d-8e51-6d2a0f7b3c88' });

  /* ---------------- normalise ---------------- */
  code(
    wf,
    '📧 Normalise Email Reply',
    [-260, -120],
    `// IMAP (simple format) -> canonical reply shape.
const j = \$json || {};

const from = (j.from || j.fromEmail || '').toString();
const match = from.match(/<([^>]+)>/);
const address = (match ? match[1] : from).trim().toLowerCase();

const body = (j.text || j.textPlain || j.textHtml || '')
  .toString()
  // strip quoted history so the AI only reads what they actually wrote
  .split(/^\\s*(?:>|On .+ wrote:|-----Original Message-----|Sent from my)/m)[0]
  .trim()
  .slice(0, 4000);

return [{
  json: {
    channel: 'email',
    identifier: address,
    sender_name: (match ? from.replace(/<[^>]+>/, '') : '').replace(/"/g, '').trim(),
    subject: (j.subject || '').toString(),
    body,
    external_id: (j.messageId || \`imap:\${address}:\${Date.now()}\`).toString(),
  },
}];`,
  );

  code(
    wf,
    '💬 Normalise WhatsApp Reply',
    [-260, 120],
    `// Evolution API messages.upsert payload -> canonical reply shape.
const root = \$json.body ?? \$json;
const data = root.data ?? root;
const key  = data.key ?? {};
const msg  = data.message ?? {};

// Ignore our own outgoing messages and group chats.
const jid = (key.remoteJid || '').toString();
if (key.fromMe === true) return [];
if (jid.endsWith('@g.us') || jid.includes('@broadcast')) return [];

// WhatsApp has a dozen message shapes; pull text out of the common ones.
const body = (
  msg.conversation ||
  msg.extendedTextMessage?.text ||
  msg.imageMessage?.caption ||
  msg.videoMessage?.caption ||
  msg.buttonsResponseMessage?.selectedDisplayText ||
  msg.listResponseMessage?.title ||
  msg.templateButtonReplyMessage?.selectedDisplayText ||
  ''
).toString().trim().slice(0, 4000);

if (!body) return [];   // sticker / audio / reaction — nothing to triage

const phone = jid.split('@')[0].split(':')[0].replace(/\\D/g, '');

return [{
  json: {
    channel: 'whatsapp',
    identifier: phone,
    sender_name: (data.pushName || '').toString(),
    subject: '',
    body,
    external_id: (key.id ? \`wa:\${key.id}\` : \`wa:\${phone}:\${Date.now()}\`),
  },
}];`,
  );

  merge(wf, '🔗 Merge Channels', [-20, 0], 2);
  configNode(wf, [200, 0]);

  set(wf, '🧷 Carry Reply', [420, 0], [
    { name: 'channel', value: "={{ $('🔗 Merge Channels').item.json.channel }}" },
    { name: 'identifier', value: "={{ $('🔗 Merge Channels').item.json.identifier }}" },
    { name: 'sender_name', value: "={{ $('🔗 Merge Channels').item.json.sender_name }}" },
    { name: 'subject', value: "={{ $('🔗 Merge Channels').item.json.subject }}" },
    { name: 'body', value: "={{ $('🔗 Merge Channels').item.json.body }}" },
    { name: 'external_id', value: "={{ $('🔗 Merge Channels').item.json.external_id }}" },
  ]);

  /* ---------------- resolve contact ---------------- */
  supabaseRpc(
    wf,
    '🔍 Find Contact',
    [660, 0],
    'sales_find_contact',
    '={\n  "p_identifier": {{ JSON.stringify($json.identifier) }}\n}',
    { onError: 'continueRegularOutput' },
  );

  code(
    wf,
    '🧩 Attach Lead Context',
    [900, 0],
    `const reply = \$('🧷 Carry Reply').item.json;
const rows  = Array.isArray(\$json) ? \$json : (\$json ? [\$json] : []);
const row   = rows.find((r) => r && r.contact_id) || null;

return [{
  json: {
    ...reply,
    known: Boolean(row),
    ...(row || {}),
    // leads we should stop talking to automatically
    terminal: ['paid', 'delivered', 'lost'].includes(row?.lead_status),
    awaiting_approval: row?.lead_status === 'prototype_sent',
  },
}];`,
  );

  ifNode(wf, '❓ Known Contact & Active?', [1140, 0], [
    cond('={{ $json.known }}', OP.boolTrue),
    cond('={{ $json.terminal }}', OP.boolFalse),
  ]);
  noOp(wf, '🙈 Ignore (unknown / closed)', [1380, 180]);

  supabaseRpc(
    wf,
    '📝 Log Inbound Message',
    [1380, -60],
    'sales_log_message',
    `={
  "p_lead_id":     {{ JSON.stringify($json.lead_id) }},
  "p_contact_id":  {{ JSON.stringify($json.contact_id) }},
  "p_direction":   "inbound",
  "p_channel":     {{ JSON.stringify($json.channel) }},
  "p_body":        {{ JSON.stringify($json.body) }},
  "p_subject":     {{ JSON.stringify($json.subject) }},
  "p_external_id": {{ JSON.stringify($json.external_id) }}
}`,
    { onError: 'continueRegularOutput' },
  );

  /* ---------------- triage ---------------- */
  set(wf, '🧠 Build Triage Prompt', [1620, -60], [
    {
      name: 'system_prompt',
      value:
        '=You are a precise sales-reply classifier. You reply with exactly one word from the allowed list and nothing else. No punctuation, no explanation.',
    },
    {
      name: 'prompt',
      value: `=A local business owner replied to my cold outreach.

Context:
- Business: {{ $('🧩 Attach Lead Context').item.json.business_name }}
- Where we are in the conversation: {{ $('🧩 Attach Lead Context').item.json.lead_status }}
- I already sent them a free mockup: {{ $('🧩 Attach Lead Context').item.json.awaiting_approval ? 'YES — ' + $('🧩 Attach Lead Context').item.json.prototype_url : 'no' }}

Their reply:
"""
{{ $('🧩 Attach Lead Context').item.json.body }}
"""

Classify into exactly one of:
INTERESTED   - wants the free mockup / says yes / asks me to send it
APPROVED     - they have SEEN the mockup and like it, or ask about price/how to pay/next steps
QUESTION     - genuine question or hesitation, not yet a yes
NOT_INTERESTED - no, stop, remove me, unsubscribe, angry, or already has a site
AUTO_REPLY   - out-of-office, delivery failure, or an automated system message

Answer with one word only.`,
    },
  ]);

  openRouter(wf, '🧠 Hermes · Triage Intent', [1860, -60], {
    model: "$('⚙️ Config').first().json.model_triage",
    maxTokens: 8,
    temperature: 0,
  }, { onError: 'continueRegularOutput' });

  code(
    wf,
    '🏷 Parse Intent',
    [2100, -60],
    `const ctx = \$('🧩 Attach Lead Context').item.json;
const raw = (\$json?.choices?.[0]?.message?.content || '').toUpperCase();

const allowed = ['APPROVED', 'NOT_INTERESTED', 'INTERESTED', 'AUTO_REPLY', 'QUESTION'];
let intent = allowed.find((a) => raw.includes(a)) || null;

// Deterministic guards that beat any LLM on these exact phrases.
const body = (ctx.body || '').toLowerCase();
if (/\\b(unsubscribe|stop|do not contact|not interested|remove me|no thanks|already have a website)\\b/.test(body)) {
  intent = 'NOT_INTERESTED';
} else if (/\\b(out of office|auto[- ]?reply|automatic reply|delivery status notification|undeliverable|mailer-daemon)\\b/.test(body)) {
  intent = 'AUTO_REPLY';
}
if (!intent) intent = 'QUESTION';   // safest default: a human answers

// "APPROVED" only makes sense once they've actually seen a mockup.
if (intent === 'APPROVED' && !ctx.awaiting_approval) intent = 'INTERESTED';

return [{ json: { ...ctx, intent } }];`,
  );

  switchNode(
    wf,
    '🔀 Route Intent',
    [2340, -60],
    [
      { key: 'INTERESTED', conditions: [cond('={{ $json.intent }}', OP.strEquals, 'INTERESTED')] },
      { key: 'APPROVED', conditions: [cond('={{ $json.intent }}', OP.strEquals, 'APPROVED')] },
      { key: 'QUESTION', conditions: [cond('={{ $json.intent }}', OP.strEquals, 'QUESTION')] },
      { key: 'NOT_INTERESTED', conditions: [cond('={{ $json.intent }}', OP.strEquals, 'NOT_INTERESTED')] },
      { key: 'AUTO_REPLY', conditions: [cond('={{ $json.intent }}', OP.strEquals, 'AUTO_REPLY')] },
    ],
  );

  /* ---------------- INTERESTED ---------------- */
  supabaseRpc(
    wf,
    '🔒 Lock Lead To This Contact',
    [2620, -420],
    'sales_lock_lead',
    `={
  "p_lead_id":    {{ JSON.stringify($json.lead_id) }},
  "p_contact_id": {{ JSON.stringify($json.contact_id) }}
}`,
  );

  http(
    wf,
    '🚀 Trigger Phase 3 (Prototype)',
    [2860, -420],
    {
      method: 'POST',
      url: "={{ $('⚙️ Config').first().json.n8n_webhook_base }}/webhook/build-prototype",
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={
  "lead_id":    {{ JSON.stringify($('🏷 Parse Intent').item.json.lead_id) }},
  "contact_id": {{ JSON.stringify($('🏷 Parse Intent').item.json.contact_id) }},
  "source":     "reply-listener"
}`,
      options: { timeout: 15000 },
    },
    { onError: 'continueRegularOutput' },
  );

  /* ---------------- APPROVED ---------------- */
  http(
    wf,
    '💳 Trigger Phase 3b (Payment Link)',
    [2620, -230],
    {
      method: 'POST',
      url: "={{ $('⚙️ Config').first().json.n8n_webhook_base }}/webhook/build-prototype",
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={
  "lead_id":    {{ JSON.stringify($json.lead_id) }},
  "contact_id": {{ JSON.stringify($json.contact_id) }},
  "stage":      "payment",
  "source":     "reply-listener"
}`,
      options: { timeout: 15000 },
    },
    { onError: 'continueRegularOutput' },
  );

  /* ---------------- QUESTION ---------------- */
  set(wf, '✍️ Build Answer Prompt', [2620, -40], [
    {
      name: 'system_prompt',
      value:
        "=You are {{ $('⚙️ Config').first().json.sender_name }} from {{ $('⚙️ Config').first().json.agency_name }}, a small web studio. You reply to prospects yourself — short, warm, concrete, no corporate voice, no bullet lists, no emoji. You never invent facts about price beyond what you're told. Reply with the message body only.",
    },
    {
      name: 'prompt',
      value: `=Prospect: {{ $json.business_name }} ({{ $json.niche }} in {{ $json.location }})
Channel: {{ $json.channel }}
Offer on the table: a FREE one-page website mockup, no commitment. If they go ahead afterwards the full site is {{ $('⚙️ Config').first().json.currency }} {{ ($('⚙️ Config').first().json.price_paise / 100).toFixed(0) }} one-off.
Mockup already sent: {{ $json.awaiting_approval ? 'yes — ' + $json.prototype_url : 'not yet' }}

They asked:
"""
{{ $json.body }}
"""

Write my reply.
- {{ $json.channel === 'whatsapp' ? 'Max 45 words, casual, WhatsApp tone.' : 'Max 110 words, plain-text email, sign off as ' + $('⚙️ Config').first().json.sender_name + '.' }}
- Answer the actual question first.
- End by nudging the next step (send the free mockup / what they think of it).
- No markdown, no subject line.`,
    },
  ]);

  openRouter(wf, '🧠 Hermes · Draft Answer', [2860, -40], {
    model: "$('⚙️ Config').first().json.model_triage",
    maxTokens: 400,
    temperature: 0.7,
  }, { onError: 'continueRegularOutput' });

  code(
    wf,
    '🧼 Clean Answer',
    [3100, -40],
    `const ctx = \$('🏷 Parse Intent').item.json;
const cfg = \$('⚙️ Config').first().json;

let text = (\$json?.choices?.[0]?.message?.content || '').trim();
text = text.replace(/^\\\`\\\`\\\`[a-z]*\\n?/i, '').replace(/\\\`\\\`\\\`\$/, '').trim();
text = text.replace(/^(subject|re):.*\$/gim, '').trim();

if (!text) {
  text = \`Hi\${ctx.contact_name && ctx.contact_name !== 'Owner' ? ' ' + ctx.contact_name : ''}, good question — happy to explain. The mockup is completely free and takes me a day; you only pay if you want the finished site. Want me to put it together for \${ctx.business_name}?\`;
}

return [{ json: { ...ctx, reply_text: text, reply_subject: ctx.subject ? (/^re:/i.test(ctx.subject) ? ctx.subject : 'Re: ' + ctx.subject) : \`Re: \${ctx.business_name}\` } }];`,
  );

  switchNode(wf, '🔀 Reply Channel', [3340, -40], [
    { key: 'email', conditions: [cond('={{ $json.channel }}', OP.strEquals, 'email')] },
    { key: 'whatsapp', conditions: [cond('={{ $json.channel }}', OP.strEquals, 'whatsapp')] },
  ]);

  sendEmail(wf, '📧 Send Email Answer', [3580, -120], {
    toExpr: '{{ $json.email }}',
    subjectExpr: '{{ $json.reply_subject }}',
    textExpr: '{{ $json.reply_text }}',
  });

  evolutionSendText(wf, '💬 Send WhatsApp Answer', [3580, 40], {
    numberExpr: '$json.phone',
    textExpr: '$json.reply_text',
  });

  supabaseRpc(
    wf,
    '📝 Log Answer',
    [3820, -40],
    'sales_log_message',
    `={
  "p_lead_id":    {{ JSON.stringify($('🧼 Clean Answer').item.json.lead_id) }},
  "p_contact_id": {{ JSON.stringify($('🧼 Clean Answer').item.json.contact_id) }},
  "p_direction":  "outbound",
  "p_channel":    {{ JSON.stringify($('🧼 Clean Answer').item.json.channel) }},
  "p_body":       {{ JSON.stringify($('🧼 Clean Answer').item.json.reply_text) }},
  "p_intent":     "ANSWER"
}`,
    { onError: 'continueRegularOutput' },
  );

  /* ---------------- NOT_INTERESTED ---------------- */
  supabaseRpc(
    wf,
    '🚫 Mark Lost',
    [2620, 200],
    'sales_mark_lost',
    `={
  "p_lead_id":    {{ JSON.stringify($json.lead_id) }},
  "p_contact_id": {{ JSON.stringify($json.contact_id) }}
}`,
    { onError: 'continueRegularOutput' },
  );

  /* ---------------- AUTO_REPLY ---------------- */
  noOp(wf, '🤖 Ignore Auto-Reply', [2620, 340]);

  /* ---------------- connections ---------------- */
  wf.connect('📥 IMAP · Email Replies', '📧 Normalise Email Reply');
  wf.connect('🌐 Webhook · WhatsApp Replies', '💬 Normalise WhatsApp Reply');
  wf.connect('📧 Normalise Email Reply', '🔗 Merge Channels', 0, 0);
  wf.connect('💬 Normalise WhatsApp Reply', '🔗 Merge Channels', 0, 1);
  wf.chain('🔗 Merge Channels', '⚙️ Config', '🧷 Carry Reply', '🔍 Find Contact', '🧩 Attach Lead Context', '❓ Known Contact & Active?');
  wf.connect('❓ Known Contact & Active?', '📝 Log Inbound Message', 0);
  wf.connect('❓ Known Contact & Active?', '🙈 Ignore (unknown / closed)', 1);
  wf.chain('📝 Log Inbound Message', '🧠 Build Triage Prompt', '🧠 Hermes · Triage Intent', '🏷 Parse Intent', '🔀 Route Intent');

  wf.connect('🔀 Route Intent', '🔒 Lock Lead To This Contact', 0);
  wf.connect('🔒 Lock Lead To This Contact', '🚀 Trigger Phase 3 (Prototype)');
  wf.connect('🔀 Route Intent', '💳 Trigger Phase 3b (Payment Link)', 1);
  wf.connect('🔀 Route Intent', '✍️ Build Answer Prompt', 2);
  wf.connect('🔀 Route Intent', '🚫 Mark Lost', 3);
  wf.connect('🔀 Route Intent', '🤖 Ignore Auto-Reply', 4);

  wf.chain('✍️ Build Answer Prompt', '🧠 Hermes · Draft Answer', '🧼 Clean Answer', '🔀 Reply Channel');
  wf.connect('🔀 Reply Channel', '📧 Send Email Answer', 0);
  wf.connect('🔀 Reply Channel', '💬 Send WhatsApp Answer', 1);
  wf.connect('📧 Send Email Answer', '📝 Log Answer');
  wf.connect('💬 Send WhatsApp Answer', '📝 Log Answer');

  /* ---------------- canvas docs ---------------- */
  wf.note(
    `## PHASE 2 · Listen, triage, lock
Two doors in, one brain.

**Evolution webhook setup**
\`\`\`
POST {{EVOLUTION_URL}}/webhook/set/{{instance}}
{ "webhook": { "enabled": true,
    "url": "https://YOUR-N8N/webhook/whatsapp-reply",
    "events": ["MESSAGES_UPSERT"] } }
\`\`\`
**IMAP:** imap.gmail.com : 993, SSL, Gmail *app password*.`,
    [-560, -420],
    600,
    320,
    HEADER_COLOR,
  );

  wf.note(
    `### The lock
\`sales_lock_lead\` sets the replier as \`primary_contact_id\`, flips the lead
to **engaged**, and marks every other contact at that business **locked** —
in one transaction, so you never end up negotiating with two people.`,
    [2520, -640],
    420,
    200,
    OK_COLOR,
  );

  wf.note(
    `### Never auto-reply into a loop
\`AUTO_REPLY\` (out-of-office, bounces) and unknown senders are dropped
silently. Regex guards override the LLM for "unsubscribe"/"stop".`,
    [2520, 460],
    420,
    180,
    WARN_COLOR,
  );

  return wf;
}
