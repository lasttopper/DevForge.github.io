#!/usr/bin/env node
/**
 * Executes the Code nodes from the generated workflows against realistic
 * fixtures, inside a fake n8n runtime.
 *
 * A JSON file that imports cleanly can still blow up on the first real
 * Apify payload — this is the cheapest way to catch that before you're
 * staring at a red node in production.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => JSON.parse(readFileSync(join(root, 'workflows', f), 'utf8'));

const wfs = {
  wf1: load('01-lead-discovery-outreach.json'),
  wf2: load('02-reply-listener-lock.json'),
  wf3: load('03-prototype-and-payment.json'),
  wf4: load('04-payment-webhook-delivery.json'),
};

/** Minimal n8n Code-node runtime. */
function runCodeNode(wf, nodeName, { input = [], nodes = {}, env = {} } = {}) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`No such node: ${nodeName}`);
  if (!node.type.endsWith('.code')) throw new Error(`${nodeName} is not a Code node`);

  const items = input.map((json) => ({ json }));

  const mkAccessor = (data, executed = true) => ({
    first: () => ({ json: Array.isArray(data) ? data[0] : data }),
    last: () => ({ json: Array.isArray(data) ? data[data.length - 1] : data }),
    all: () => (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
    item: { json: Array.isArray(data) ? data[0] : data },
    isExecuted: executed,
  });

  const sandbox = {
    $input: { all: () => items, first: () => items[0], last: () => items[items.length - 1] },
    $json: items[0]?.json ?? {},
    $items: () => items,
    $env: env,
    $: (name) => {
      if (!(name in nodes)) throw new Error(`fixture missing for $('${name}')`);
      const v = nodes[name];
      return mkAccessor(v.data ?? v, v.executed !== false);
    },
    $node: new Proxy({}, { get: (_, k) => ({ json: nodes[k]?.data ?? nodes[k] ?? {} }) }),
    require: nodeRequire,
    Buffer,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    JSON, Math, Date, Number, String, Boolean, Array, Object, RegExp, Error, isNaN, parseInt, parseFloat,
  };

  const script = new vm.Script(`(function(){ ${node.parameters.jsCode} })()`);
  const result = script.runInNewContext(sandbox, { timeout: 5000 });
  // vm runs in a separate realm, so objects coming back carry that realm's
  // prototypes and fail strict deep-equality. Re-hydrate into this realm.
  const host = JSON.parse(JSON.stringify(result ?? []));
  return Array.isArray(host) ? host : [host];
}

/* ------------------------------------------------------------------ */
let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✔ ${name}`); pass++; }
  catch (e) { console.error(`  ✖ ${name}\n      ${e.message}`); fail++; }
};

const CFG = {
  supabase_url: 'https://x.supabase.co',
  agency_name: 'Studio Nova',
  sender_name: 'Alex',
  currency: 'INR',
  price_paise: 150000,
  max_new_leads_per_run: 10,
  default_country_code: '91',
  dry_run: false,
  model_coder: 'deepseek/deepseek-chat-v3-0324:free',
  searches_per_run: 2,
  apify_max_places: 20,
  build_mode: 'auto',
  razorpay_webhook_secret: 'whsec_test_123',
};

/* ============================ WF1 ============================ */
console.log('\n01 · Lead Discovery');

test('Search Plan rotates and respects searches_per_run', () => {
  const out = runCodeNode(wfs.wf1, '🎯 Search Plan', { nodes: { '⚙️ Config': CFG } });
  assert.equal(out.length, 2);
  assert.ok(out[0].json.query.length > 0);
  assert.ok(out[0].json.niche && out[0].json.location);
});

test('Normalise & Qualify: drops sites, keeps social-only, formats phone', () => {
  const apify = [
    { title: 'Sharma Plumbing', website: 'https://sharma.com', phoneUnformatted: '+919812345678', placeId: 'p1' },
    { title: 'Verma Plumbers', website: '', phoneUnformatted: '+91 98765 43210', placeId: 'p2', totalScore: 4.5, reviewsCount: 30, address: 'MI Road' },
    { title: 'Social Only Plumbing', website: 'https://facebook.com/x', phone: '9812345670', placeId: 'p3' },
    { title: 'Closed Co', website: '', phoneUnformatted: '919999999999', permanentlyClosed: true, placeId: 'p4' },
    { title: 'No Contact', website: '', placeId: 'p5' },
    { title: 'Dupe', website: '', phoneUnformatted: '+91 98765 43210', placeId: 'p6' },
  ];
  const out = runCodeNode(wfs.wf1, '🧹 Normalise & Qualify', {
    input: apify,
    nodes: { '⚙️ Config': CFG, '🎯 Search Plan': { niche: 'plumber', location: 'Jaipur' } },
  });
  const names = out.map((o) => o.json.business_name);
  assert.deepEqual(names, ['Verma Plumbers', 'Social Only Plumbing']);
  assert.equal(out[0].json.phone, '919876543210', 'phone must be digits-only intl');
  assert.equal(out[1].json.phone, '919812345670', 'bare 10-digit gets country code');
  assert.equal(out[0].json.metadata.rating, 4.5);
});

test('Normalise & Qualify: emits sentinel when batch is empty', () => {
  const out = runCodeNode(wfs.wf1, '🧹 Normalise & Qualify', {
    input: [{ title: 'Has Site', website: 'https://a.com', phone: '919812345678' }],
    nodes: { '⚙️ Config': CFG, '🎯 Search Plan': { niche: 'plumber', location: 'Jaipur' } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.empty, true);
  assert.ok(!out[0].json.business_name, 'sentinel must fail the IF check');
});

test('Normalise & Qualify: respects max_new_leads_per_run', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    title: `Biz ${i}`, website: '', phoneUnformatted: `9198765${String(i).padStart(5, '0')}`, placeId: `p${i}`,
  }));
  const out = runCodeNode(wfs.wf1, '🧹 Normalise & Qualify', {
    input: many,
    nodes: { '⚙️ Config': { ...CFG, max_new_leads_per_run: 3 }, '🎯 Search Plan': { niche: 'x', location: 'y' } },
  });
  assert.equal(out.length, 3);
});

test('Keep Only Brand-New Leads unwraps RPC rows and drops existing', () => {
  const out = runCodeNode(wfs.wf1, '🆕 Keep Only Brand-New Leads', {
    input: [
      [{ lead_id: 'L1', contact_id: 'C1', is_new: true, business_name: 'A' }],
      [{ lead_id: 'L2', contact_id: 'C2', is_new: false, business_name: 'B' }],
      { message: 'error', code: '23505' },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.lead_id, 'L1');
});

test('Parse AI Copy: handles fenced JSON', () => {
  const lead = { lead_id: 'L1', business_name: 'Verma Plumbers', niche: 'plumber', location: 'Jaipur', contact_name: 'Owner', email: 'a@b.com', phone: '919876543210' };
  const out = runCodeNode(wfs.wf1, '🔎 Parse AI Copy', {
    input: [{ choices: [{ message: { content: '```json\n{"subject":"quick idea","email":"Hi there","whatsapp":"yo"}\n```' } }] }],
    nodes: { '🔁 One Lead At A Time': lead, '⚙️ Config': CFG },
  });
  assert.equal(out[0].json.subject, 'quick idea');
  assert.equal(out[0].json.ai_used, true);
  assert.equal(out[0].json.has_email, true);
  assert.equal(out[0].json.has_phone, true);
});

test('Parse AI Copy: falls back when the model returns garbage', () => {
  const lead = { lead_id: 'L1', business_name: 'Verma Plumbers', niche: 'plumber', location: 'Jaipur', contact_name: 'Owner', email: '', phone: '919876543210' };
  const out = runCodeNode(wfs.wf1, '🔎 Parse AI Copy', {
    input: [{ choices: [{ message: { content: 'Sure! Here is your copy:' } }] }],
    nodes: { '🔁 One Lead At A Time': lead, '⚙️ Config': CFG },
  });
  assert.equal(out[0].json.ai_used, false);
  assert.ok(out[0].json.email_body.includes('Verma Plumbers'));
  assert.ok(out[0].json.whatsapp_body.length > 20);
  assert.equal(out[0].json.has_email, false);
});

test('Parse AI Copy: survives a totally empty AI response', () => {
  const lead = { lead_id: 'L1', business_name: 'X', niche: 'gym', location: 'Udaipur', contact_name: '', email: 'a@b.com', phone: '' };
  const out = runCodeNode(wfs.wf1, '🔎 Parse AI Copy', {
    input: [{}],
    nodes: { '🔁 One Lead At A Time': lead, '⚙️ Config': CFG },
  });
  assert.ok(out[0].json.subject);
  assert.ok(out[0].json.email_body);
});

test('Summarise Send detects which channels fired', () => {
  const lead = { lead_id: 'L1', contact_id: 'C1', email_body: 'e', whatsapp_body: 'w', subject: 's' };
  const out = runCodeNode(wfs.wf1, '🧾 Summarise Send', {
    input: [{ accepted: ['a@b.com'], messageId: '<1>' }, { key: { id: 'X' }, status: 'PENDING' }],
    nodes: { '🔎 Parse AI Copy': lead },
  });
  assert.equal(out[0].json.sent_email, true);
  assert.equal(out[0].json.sent_whatsapp, true);
  assert.equal(out[0].json.channel_used, 'email+whatsapp');
});

test('SAFETY: dry_run defaults to true on a fresh import', () => {
  // A freshly imported workflow, with no env vars set at all, must not be
  // able to message a real business.
  for (const [name, wf] of Object.entries(wfs)) {
    const cfg = wf.nodes.find((n) => n.name === '⚙️ Config');
    if (!cfg) continue;
    const dry = cfg.parameters.assignments.assignments.find((a) => a.name === 'dry_run');
    assert.ok(dry, `${name} has no dry_run field`);
    // evaluate the expression body with an empty $env
    const expr = String(dry.value).replace(/^=\{\{|\}\}$/g, '').trim();
    const val = new Function('$env', `return (${expr});`)({});
    assert.equal(val, true, `${name}: dry_run must default to true, got ${val}`);
    // and it must still be switchable off
    const off = new Function('$env', `return (${expr});`)({ DRY_RUN: 'false' });
    assert.equal(off, false, `${name}: DRY_RUN=false must disable dry run`);
  }
});

/* ============================ WF2 ============================ */
console.log('\n02 · Reply Listener');

test('Normalise Email Reply strips quoted history and parses address', () => {
  const out = runCodeNode(wfs.wf2, '📧 Normalise Email Reply', {
    input: [{
      from: '"Raj Verma" <raj@verma.com>',
      subject: 'Re: quick idea',
      text: 'Yes please send it!\n\nOn Mon, Alex wrote:\n> original pitch here',
      messageId: '<abc@mail>',
    }],
  });
  assert.equal(out[0].json.identifier, 'raj@verma.com');
  assert.equal(out[0].json.channel, 'email');
  assert.equal(out[0].json.body, 'Yes please send it!');
  assert.equal(out[0].json.external_id, '<abc@mail>');
});

test('Normalise WhatsApp Reply extracts text and phone', () => {
  const out = runCodeNode(wfs.wf2, '💬 Normalise WhatsApp Reply', {
    input: [{
      body: { data: { key: { remoteJid: '919876543210@s.whatsapp.net', id: 'MSG1', fromMe: false }, pushName: 'Raj', message: { conversation: "Hi, I'm interested" } } },
    }],
  });
  assert.equal(out[0].json.identifier, '919876543210');
  assert.equal(out[0].json.body, "Hi, I'm interested");
  assert.equal(out[0].json.external_id, 'wa:MSG1');
});

test('Normalise WhatsApp Reply handles extendedTextMessage', () => {
  const out = runCodeNode(wfs.wf2, '💬 Normalise WhatsApp Reply', {
    input: [{ data: { key: { remoteJid: '919876543210@s.whatsapp.net', id: 'M2' }, message: { extendedTextMessage: { text: 'how much?' } } } }],
  });
  assert.equal(out[0].json.body, 'how much?');
});

test('Normalise WhatsApp Reply ignores own messages, groups and stickers', () => {
  const own = runCodeNode(wfs.wf2, '💬 Normalise WhatsApp Reply', {
    input: [{ data: { key: { remoteJid: '91987@s.whatsapp.net', fromMe: true }, message: { conversation: 'hi' } } }],
  });
  assert.equal(own.length, 0);
  const group = runCodeNode(wfs.wf2, '💬 Normalise WhatsApp Reply', {
    input: [{ data: { key: { remoteJid: '12345@g.us' }, message: { conversation: 'hi' } } }],
  });
  assert.equal(group.length, 0);
  const sticker = runCodeNode(wfs.wf2, '💬 Normalise WhatsApp Reply', {
    input: [{ data: { key: { remoteJid: '91987@s.whatsapp.net', id: 'S1' }, message: { stickerMessage: {} } } }],
  });
  assert.equal(sticker.length, 0);
});

const REPLY = { channel: 'whatsapp', identifier: '919876543210', body: 'yes send it', subject: '', external_id: 'wa:1', sender_name: 'Raj' };

test('Attach Lead Context flags unknown senders', () => {
  const out = runCodeNode(wfs.wf2, '🧩 Attach Lead Context', {
    input: [[]],
    nodes: { '🧷 Carry Reply': REPLY },
  });
  assert.equal(out[0].json.known, false);
});

test('Attach Lead Context flags terminal and awaiting-approval leads', () => {
  const paid = runCodeNode(wfs.wf2, '🧩 Attach Lead Context', {
    input: [[{ contact_id: 'C1', lead_id: 'L1', lead_status: 'paid' }]],
    nodes: { '🧷 Carry Reply': REPLY },
  });
  assert.equal(paid[0].json.terminal, true);

  const proto = runCodeNode(wfs.wf2, '🧩 Attach Lead Context', {
    input: [[{ contact_id: 'C1', lead_id: 'L1', lead_status: 'prototype_sent', prototype_url: 'https://x.vercel.app' }]],
    nodes: { '🧷 Carry Reply': REPLY },
  });
  assert.equal(proto[0].json.terminal, false);
  assert.equal(proto[0].json.awaiting_approval, true);
});

const ctxFor = (over = {}) => ({
  lead_id: 'L1', contact_id: 'C1', business_name: 'Verma Plumbers', body: 'yes please',
  lead_status: 'contacted', awaiting_approval: false, channel: 'whatsapp', contact_name: 'Raj', ...over,
});

test('Parse Intent reads the model answer', () => {
  const out = runCodeNode(wfs.wf2, '🏷 Parse Intent', {
    input: [{ choices: [{ message: { content: 'INTERESTED' } }] }],
    nodes: { '🧩 Attach Lead Context': ctxFor() },
  });
  assert.equal(out[0].json.intent, 'INTERESTED');
});

test('Parse Intent: regex beats the LLM on unsubscribe', () => {
  const out = runCodeNode(wfs.wf2, '🏷 Parse Intent', {
    input: [{ choices: [{ message: { content: 'INTERESTED' } }] }],
    nodes: { '🧩 Attach Lead Context': ctxFor({ body: 'Please remove me from your list' }) },
  });
  assert.equal(out[0].json.intent, 'NOT_INTERESTED');
});

test('Parse Intent: detects out-of-office', () => {
  const out = runCodeNode(wfs.wf2, '🏷 Parse Intent', {
    input: [{ choices: [{ message: { content: 'QUESTION' } }] }],
    nodes: { '🧩 Attach Lead Context': ctxFor({ body: 'Automatic reply: I am out of office until Monday' }) },
  });
  assert.equal(out[0].json.intent, 'AUTO_REPLY');
});

test('Parse Intent: APPROVED downgrades to INTERESTED before a mockup exists', () => {
  const out = runCodeNode(wfs.wf2, '🏷 Parse Intent', {
    input: [{ choices: [{ message: { content: 'APPROVED' } }] }],
    nodes: { '🧩 Attach Lead Context': ctxFor({ awaiting_approval: false }) },
  });
  assert.equal(out[0].json.intent, 'INTERESTED');
});

test('Parse Intent: APPROVED survives once the mockup was sent', () => {
  const out = runCodeNode(wfs.wf2, '🏷 Parse Intent', {
    input: [{ choices: [{ message: { content: 'APPROVED, looks great' } }] }],
    nodes: { '🧩 Attach Lead Context': ctxFor({ awaiting_approval: true, lead_status: 'prototype_sent' }) },
  });
  assert.equal(out[0].json.intent, 'APPROVED');
});

test('Parse Intent defaults to QUESTION on empty model output', () => {
  const out = runCodeNode(wfs.wf2, '🏷 Parse Intent', {
    input: [{}],
    nodes: { '🧩 Attach Lead Context': ctxFor({ body: 'hmm' }) },
  });
  assert.equal(out[0].json.intent, 'QUESTION');
});

test('Clean Answer strips fences and builds a Re: subject', () => {
  const out = runCodeNode(wfs.wf2, '🧼 Clean Answer', {
    input: [{ choices: [{ message: { content: '```\nSubject: hello\nIt is free, no catch.\n```' } }] }],
    nodes: { '🏷 Parse Intent': ctxFor({ channel: 'email', subject: 'quick idea' }), '⚙️ Config': CFG },
  });
  assert.ok(!out[0].json.reply_text.includes('```'));
  assert.ok(!/^subject:/im.test(out[0].json.reply_text));
  assert.equal(out[0].json.reply_subject, 'Re: quick idea');
});

test('Clean Answer falls back when the model returns nothing', () => {
  const out = runCodeNode(wfs.wf2, '🧼 Clean Answer', {
    input: [{ choices: [{ message: { content: '' } }] }],
    nodes: { '🏷 Parse Intent': ctxFor(), '⚙️ Config': CFG },
  });
  assert.ok(out[0].json.reply_text.includes('Verma Plumbers'));
});

/* ============================ WF3 ============================ */
console.log('\n03 · Prototype & Payment');

test('Resolve Trigger reads the webhook body', () => {
  const out = runCodeNode(wfs.wf3, '🧭 Resolve Trigger', {
    nodes: {
      '🌐 Webhook · build-prototype': { data: { body: { lead_id: 'L1', contact_id: 'C1', stage: 'payment' } }, executed: true },
    },
  });
  assert.equal(out[0].json.mode, 'direct');
  assert.equal(out[0].json.stage, 'payment');
});

test('Resolve Trigger falls back to claim mode on schedule', () => {
  const out = runCodeNode(wfs.wf3, '🧭 Resolve Trigger', {
    nodes: { '🌐 Webhook · build-prototype': { data: {}, executed: false } },
  });
  assert.equal(out[0].json.mode, 'claim');
  assert.equal(out[0].json.stage, 'prototype');
});

test('Normalise Lead flattens rows and de-dupes', () => {
  const row = { lead_id: 'L1', contact_id: 'C1', business_name: 'Verma', niche: 'plumber', location: 'Jaipur', email: 'a@b.com', phone: '', metadata: { address: 'MI Rd' } };
  const out = runCodeNode(wfs.wf3, '🧾 Normalise Lead', {
    input: [[row], [row]],
    nodes: { '🧭 Resolve Trigger': { mode: 'direct', stage: 'prototype', contact_id: 'C1' } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.channel, 'email');
  assert.equal(out[0].json.stage, 'prototype');
});

const GOOD_HTML = '<!DOCTYPE html><html lang="en"><head><title>Verma Plumbers</title></head><body>' + 'x'.repeat(900) + '</body></html>';

test('Extract & Validate HTML strips fences and slugifies the project', () => {
  const ctx = { lead_id: '0123abcd-1111-2222-3333-444444444444', business_name: 'Verma Plumbers & Sons' };
  const out = runCodeNode(wfs.wf3, '🧽 Extract & Validate HTML', {
    input: [{ choices: [{ message: { content: '```html\n' + GOOD_HTML + '\n```' } }] }],
    nodes: { '🎨 Build Site Prompt': ctx, '🧾 Normalise Lead': ctx },
  });
  assert.ok(out[0].json.html.startsWith('<!DOCTYPE html>'));
  assert.ok(out[0].json.html.endsWith('</html>'));
  assert.equal(out[0].json.project_name, 'proto-verma-plumbers-sons-0123abcd');
});

test('Extract & Validate HTML rejects truncated output', () => {
  const ctx = { lead_id: 'L1', business_name: 'Verma' };
  assert.throws(() => runCodeNode(wfs.wf3, '🧽 Extract & Validate HTML', {
    input: [{ choices: [{ message: { content: '<!DOCTYPE html><html><body>oops' } }] }],
    nodes: { '🎨 Build Site Prompt': ctx, '🧾 Normalise Lead': ctx },
  }), /failed validation/);
});

test('Extract & Validate HTML rejects placeholder text', () => {
  const ctx = { lead_id: 'L1', business_name: 'Verma' };
  const bad = '<!DOCTYPE html><html><body>[Business Name] ' + 'x'.repeat(900) + '</body></html>';
  assert.throws(() => runCodeNode(wfs.wf3, '🧽 Extract & Validate HTML', {
    input: [{ choices: [{ message: { content: bad } }] }],
    nodes: { '🎨 Build Site Prompt': ctx, '🧾 Normalise Lead': ctx },
  }), /failed validation/);
});

test('Prototype URL adds the scheme Vercel omits', () => {
  const out = runCodeNode(wfs.wf3, '🔗 Prototype URL', {
    input: [{ id: 'dpl_1', url: 'proto-verma-0123abcd.vercel.app' }],
    nodes: { '🧽 Extract & Validate HTML': { lead_id: 'L1', business_name: 'Verma' } },
  });
  assert.equal(out[0].json.prototype_url, 'https://proto-verma-0123abcd.vercel.app');
});

test('Prototype URL throws when Vercel returns an error body', () => {
  assert.throws(() => runCodeNode(wfs.wf3, '🔗 Prototype URL', {
    input: [{ error: { code: 'forbidden' } }],
    nodes: { '🧽 Extract & Validate HTML': { lead_id: 'L1' } },
  }), /did not return a deployment URL/);
});

test('Payment Payload builds a valid Razorpay customer', () => {
  const out = runCodeNode(wfs.wf3, '🧮 Payment Payload', {
    input: [{ lead_id: 'L1', business_name: 'Verma', contact_name: 'Raj', email: 'a@b.com', phone: '919876543210' }],
    nodes: { '⚙️ Config': CFG },
  });
  assert.equal(out[0].json.amount, 150000);
  assert.equal(out[0].json.customer.contact, '+919876543210');
  assert.equal(out[0].json.customer.email, 'a@b.com');
  assert.ok(out[0].json.expire_by > Math.floor(Date.now() / 1000));
});

test('Payment Payload omits contact fields we do not have', () => {
  const out = runCodeNode(wfs.wf3, '🧮 Payment Payload', {
    input: [{ lead_id: 'L1', business_name: 'Verma', contact_name: 'Raj', email: '', phone: '' }],
    nodes: { '⚙️ Config': CFG },
  });
  assert.equal('email' in out[0].json.customer, false);
  assert.equal('contact' in out[0].json.customer, false);
});

test('Payment Payload rejects a nonsense price', () => {
  assert.throws(() => runCodeNode(wfs.wf3, '🧮 Payment Payload', {
    input: [{ lead_id: 'L1', business_name: 'V', contact_name: 'R' }],
    nodes: { '⚙️ Config': { ...CFG, price_paise: 5 } },
  }), /paise/);
});

test('Capture Link formats the amount for humans', () => {
  const out = runCodeNode(wfs.wf3, '🧷 Capture Link', {
    input: [{ id: 'plink_1', short_url: 'https://rzp.io/i/abc', amount: 150000 }],
    nodes: { '🧮 Payment Payload': { lead_id: 'L1', business_name: 'Verma', amount: 150000, currency: 'INR', contact_name: 'Raj' } },
  });
  assert.equal(out[0].json.razorpay_link_id, 'plink_1');
  assert.equal(out[0].json.amount_display, '1,500');
});

test('Compose messages produce non-empty email + whatsapp copy', () => {
  const proto = runCodeNode(wfs.wf3, '💌 Compose Prototype Message', {
    nodes: {
      '🔗 Prototype URL': { lead_id: 'L1', business_name: 'Verma Plumbers', contact_name: 'Raj', prototype_url: 'https://x.vercel.app' },
      '⚙️ Config': CFG,
    },
  });
  assert.ok(proto[0].json.email_body.includes('https://x.vercel.app'));
  assert.ok(proto[0].json.whatsapp_body.includes('Verma Plumbers'));

  const pay = runCodeNode(wfs.wf3, '💌 Compose Payment Message', {
    nodes: {
      '🧷 Capture Link': { lead_id: 'L1', business_name: 'Verma', contact_name: 'Raj', payment_url: 'https://rzp.io/i/abc', amount_display: '1,500', currency: 'INR' },
      '⚙️ Config': CFG,
    },
  });
  assert.ok(pay[0].json.email_body.includes('₹1,500'));
  assert.ok(pay[0].json.whatsapp_body.includes('https://rzp.io/i/abc'));
});

/* ============================ WF4 ============================ */
console.log('\n04 · Payment Webhook & Delivery');

const SECRET = 'whsec_test_123';
const rzpBody = JSON.stringify({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: 'plink_1', amount: 150000, notes: { lead_id: 'L1' } } },
    payment: { entity: { id: 'pay_1', amount: 150000 } },
  },
});
const sign = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('hex');

test('Verify Signature accepts a correctly signed payload', () => {
  const out = runCodeNode(wfs.wf4, '🔐 Verify Razorpay Signature', {
    nodes: {
      '⚙️ Config': CFG,
      '🌐 Webhook · razorpay': { headers: { 'x-razorpay-signature': sign(rzpBody, SECRET) }, body: rzpBody },
    },
  });
  assert.equal(out[0].json.strict_valid, true);
  assert.equal(out[0].json.is_paid_event, true);
  assert.equal(out[0].json.link_id, 'plink_1');
  assert.equal(out[0].json.lead_id, 'L1');
  assert.equal(out[0].json.razorpay_payment_id, 'pay_1');
});

test('Verify Signature accepts a base64 raw body', () => {
  const out = runCodeNode(wfs.wf4, '🔐 Verify Razorpay Signature', {
    nodes: {
      '⚙️ Config': CFG,
      '🌐 Webhook · razorpay': {
        headers: { 'x-razorpay-signature': sign(rzpBody, SECRET) },
        body: Buffer.from(rzpBody, 'utf8').toString('base64'),
      },
    },
  });
  assert.equal(out[0].json.strict_valid, true);
});

test('Verify Signature REJECTS a forged signature', () => {
  const out = runCodeNode(wfs.wf4, '🔐 Verify Razorpay Signature', {
    nodes: { '⚙️ Config': CFG, '🌐 Webhook · razorpay': { headers: { 'x-razorpay-signature': 'deadbeef' }, body: rzpBody } },
  });
  assert.equal(out[0].json.valid, false, 'forged signature must not pass');
  assert.equal(out[0].json.strict_valid, false);
});

test('Verify Signature REJECTS a tampered body', () => {
  const tampered = rzpBody.replace('150000', '100');
  const out = runCodeNode(wfs.wf4, '🔐 Verify Razorpay Signature', {
    nodes: { '⚙️ Config': CFG, '🌐 Webhook · razorpay': { headers: { 'x-razorpay-signature': sign(rzpBody, SECRET) }, body: tampered } },
  });
  assert.equal(out[0].json.valid, false);
});

test('Verify Signature ignores non-payment events', () => {
  const other = JSON.stringify({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: 'plink_9', notes: {} } } } });
  const out = runCodeNode(wfs.wf4, '🔐 Verify Razorpay Signature', {
    nodes: { '⚙️ Config': CFG, '🌐 Webhook · razorpay': { headers: { 'x-razorpay-signature': sign(other, SECRET) }, body: other } },
  });
  assert.equal(out[0].json.is_paid_event, false);
});

test('Payment Context flags a duplicate webhook', () => {
  const out = runCodeNode(wfs.wf4, '🧾 Payment Context', {
    input: [[{ lead_id: 'L1', business_name: 'Verma', already_paid: true, amount: 150000 }]],
    nodes: { '🔐 Verify Razorpay Signature': { link_id: 'plink_1', razorpay_payment_id: 'pay_1', amount: 150000 } },
  });
  assert.equal(out[0].json.skip, true);
});

test('Payment Context throws on an unknown payment link', () => {
  assert.throws(() => runCodeNode(wfs.wf4, '🧾 Payment Context', {
    input: [[]],
    nodes: { '🔐 Verify Razorpay Signature': { link_id: 'plink_x', amount: 0 } },
  }), /not in the payments table/);
});

test('Payment Context builds a display amount on first payment', () => {
  const out = runCodeNode(wfs.wf4, '🧾 Payment Context', {
    input: [[{ lead_id: 'L1', business_name: 'Verma', already_paid: false, amount: 150000, email: 'a@b.com', contact_name: 'Raj' }]],
    nodes: { '🔐 Verify Razorpay Signature': { link_id: 'plink_1', razorpay_payment_id: 'pay_1', amount: 150000 } },
  });
  assert.equal(out[0].json.skip, false);
  assert.equal(out[0].json.amount_display, '1,500');
});

test('Choose Build Mode honours build_mode from Config', () => {
  const receipt = { '💌 Compose Receipt': { lead_id: 'L1', business_name: 'Verma' } };
  assert.equal(runCodeNode(wfs.wf4, '🛠 Choose Build Mode',
    { nodes: { ...receipt, '⚙️ Config': CFG } })[0].json.build_mode, 'auto');
  assert.equal(runCodeNode(wfs.wf4, '🛠 Choose Build Mode',
    { nodes: { ...receipt, '⚙️ Config': { ...CFG, build_mode: 'manual' } } })[0].json.build_mode, 'manual');
});

test('Verify Signature warns but does not crash when no secret is set', () => {
  const out = runCodeNode(wfs.wf4, '🔐 Verify Razorpay Signature', {
    nodes: { '⚙️ Config': { ...CFG, razorpay_webhook_secret: '' },
             '🌐 Webhook · razorpay': { headers: {}, body: rzpBody } },
  });
  assert.equal(out[0].json.valid, true, 'unset secret falls through so test mode still works');
  assert.equal(out[0].json.strict_valid, false);
});

test('Validate Full Site rejects truncation with a loud message', () => {
  const ctx = { lead_id: 'L1', business_name: 'Verma' };
  assert.throws(() => runCodeNode(wfs.wf4, '🧽 Validate Full Site', {
    input: [{ choices: [{ message: { content: '<!DOCTYPE html><html><body>short' } }] }],
    nodes: { '🛠 Choose Build Mode': ctx },
  }), /PAYMENT IS ALREADY TAKEN/);
});

test('Validate Full Site accepts a full document', () => {
  const ctx = { lead_id: '0123abcd-0000-0000-0000-000000000000', business_name: 'Verma Plumbers' };
  const html = '<!DOCTYPE html><html lang="en"><head><title>V</title></head><body>' + 'y'.repeat(4000) + '</body></html>';
  const out = runCodeNode(wfs.wf4, '🧽 Validate Full Site', {
    input: [{ choices: [{ message: { content: html } }] }],
    nodes: { '🛠 Choose Build Mode': ctx },
  });
  assert.equal(out[0].json.project_name, 'verma-plumbers-0123abcd');
});

test('Compose Delivery includes the live URL on both channels', () => {
  const out = runCodeNode(wfs.wf4, '💌 Compose Delivery', {
    nodes: {
      '🔗 Final URL': { lead_id: 'L1', business_name: 'Verma Plumbers', contact_name: 'Raj', final_url: 'https://verma.vercel.app' },
      '⚙️ Config': CFG,
    },
  });
  assert.ok(out[0].json.email_body.includes('https://verma.vercel.app'));
  assert.ok(out[0].json.whatsapp_body.includes('https://verma.vercel.app'));
  assert.ok(out[0].json.subject.includes('Verma Plumbers'));
});

/* ------------------------------------------------------------------ */
console.log(`\n${fail ? '✖' : '✔'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
