#!/usr/bin/env node
/**
 * Runs sql/01_schema.sql + sql/02_functions.sql against a real Postgres
 * (PGlite / WASM) and exercises every RPC the workflows call.
 *
 *   npm i -D @electric-sql/pglite && node scripts/test-sql.mjs
 *
 * This is how the `#variable_conflict use_column` bug was caught: PL/pgSQL
 * RETURNS TABLE output names shadow real column names, which only blows up
 * at call time, never at CREATE FUNCTION time.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.log('⚠ @electric-sql/pglite not installed — skipping SQL tests.');
  console.log('  npm i -D @electric-sql/pglite');
  process.exit(0);
}

const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = await new PGlite();

// pgcrypto is not bundled with PGlite; gen_random_uuid() is core since PG13.

try { await db.exec(readFileSync(R+'/sql/01_schema.sql','utf8').replace(/create extension[^;]*;/i,'')); console.log('✔ 01_schema.sql applied'); }
catch(e){ console.error('✖ schema:', e.message); process.exit(1); }

try { await db.exec(readFileSync(R+'/sql/02_functions.sql','utf8')); console.log('✔ 02_functions.sql applied'); }
catch(e){ console.error('✖ functions:', e.message); process.exit(1); }

const q = async (sql, params) => (await db.query(sql, params)).rows;

// ---- upsert lead
let r = await q(`select * from sales_upsert_lead($1::jsonb)`, [JSON.stringify({
  business_name:'Verma Plumbers', niche:'plumber', location:'Jaipur',
  google_place_id:'p1', phone:'919876543210', email:'raj@verma.com', contact_name:'Raj',
  metadata:{address:'MI Road'}
})]);
console.log('upsert1:', r[0].is_new, r[0].channel_preference);
assert.equal(r[0].is_new, true);
assert.equal(r[0].channel_preference, 'both');
const leadId = r[0].lead_id, contactId = r[0].contact_id;

// ---- dedupe by place id
r = await q(`select * from sales_upsert_lead($1::jsonb)`, [JSON.stringify({
  business_name:'Verma Plumbers', google_place_id:'p1', phone:'919876543210'
})]);
assert.equal(r[0].is_new, false, 'dedupe by place_id');
console.log('✔ dedupe by place_id');

// ---- dedupe by phone with different place id
r = await q(`select * from sales_upsert_lead($1::jsonb)`, [JSON.stringify({
  business_name:'Verma Plumbing Co', google_place_id:'p999', phone:'919876543210'
})]);
assert.equal(r[0].is_new, false, 'dedupe by phone');
console.log('✔ dedupe by phone');

// ---- second contact at same business
r = await q(`select * from sales_upsert_lead($1::jsonb)`, [JSON.stringify({
  business_name:'Verma Plumbers', google_place_id:'p1', phone:'919811111111', contact_name:'Sunil'
})]);
const contact2 = r[0].contact_id;
assert.notEqual(contact2, contactId);
console.log('✔ second contact added to same lead');

// ---- mark contacted
await q(`select * from sales_mark_contacted($1,$2)`, [contactId, leadId]);
r = await q(`select status from leads where id=$1`, [leadId]);
assert.equal(r[0].status,'contacted');
console.log('✔ mark_contacted');

// ---- find contact by email and fuzzy phone
r = await q(`select * from sales_find_contact($1)`, ['raj@verma.com']);
assert.equal(r[0].contact_id, contactId);
r = await q(`select * from sales_find_contact($1)`, ['+91 98765 43210']);
assert.equal(r[0].contact_id, contactId, 'fuzzy phone match');
r = await q(`select * from sales_find_contact($1)`, ['9876543210']);
assert.equal(r[0].contact_id, contactId, 'bare 10-digit match');
r = await q(`select * from sales_find_contact($1)`, ['nobody@nowhere.com']);
assert.equal(r.length, 0);
console.log('✔ find_contact (email, intl phone, bare phone, miss)');

// ---- lock
r = await q(`select * from sales_lock_lead($1,$2)`, [leadId, contactId]);
assert.equal(r[0].status,'engaged');
assert.equal(r[0].primary_contact_id, contactId);
assert.equal(r[0].locked_out, 1);
const st = await q(`select status from contacts where id=$1`, [contact2]);
assert.equal(st[0].status,'locked');
console.log('✔ lock_lead locks the other contact');

// ---- claim (skip locked)
r = await q(`select * from sales_claim_leads('engaged','engaged',5)`);
assert.equal(r.length,1);
assert.equal(r[0].contact_id, contactId, 'claim returns primary contact');
console.log('✔ claim_leads');

// ---- prototype
r = await q(`select * from sales_set_prototype($1,$2)`, [leadId,'https://proto.vercel.app']);
assert.equal(r[0].status,'prototype_sent');
console.log('✔ set_prototype');

// ---- get lead
r = await q(`select * from sales_get_lead($1)`, [leadId]);
assert.equal(r[0].business_name,'Verma Plumbers');
assert.equal(r[0].contact_id, contactId);
console.log('✔ get_lead');

// ---- payment
r = await q(`select * from sales_create_payment($1,$2,$3,$4,$5,$6)`,
  [leadId, contactId, 'plink_1', 150000, 'INR', 'https://rzp.io/i/abc']);
assert.ok(r[0].payment_id);
r = await q(`select status from leads where id=$1`,[leadId]);
assert.equal(r[0].status,'payment_sent');
console.log('✔ create_payment');

// idempotent create
r = await q(`select * from sales_create_payment($1,$2,$3,$4,$5,$6)`,
  [leadId, contactId, 'plink_1', 150000, 'INR', 'https://rzp.io/i/abc']);
const cnt = await q(`select count(*)::int c from payments where razorpay_payment_link_id='plink_1'`);
assert.equal(cnt[0].c,1);
console.log('✔ create_payment is idempotent');

// ---- paid
r = await q(`select * from sales_record_payment_paid($1,$2,$3)`, ['plink_1','pay_1',150000]);
assert.equal(r[0].already_paid, false);
assert.equal(r[0].business_name,'Verma Plumbers');
let lead = await q(`select status from leads where id=$1`,[leadId]);
assert.equal(lead[0].status,'paid');
console.log('✔ record_payment_paid');

// replay
r = await q(`select * from sales_record_payment_paid($1,$2,$3)`, ['plink_1','pay_1',150000]);
assert.equal(r[0].already_paid, true, 'replay must be flagged');
console.log('✔ record_payment_paid is idempotent (webhook replay)');

// unknown link
r = await q(`select * from sales_record_payment_paid($1,$2,$3)`, ['plink_unknown','x',1]);
assert.equal(r.length,0);
console.log('✔ unknown payment link returns no rows');

// ---- messages
r = await q(`select sales_log_message($1,$2,'inbound','whatsapp','hi',null,null,'wa:1') id`,[leadId,contactId]);
const m1 = r[0].id;
r = await q(`select sales_log_message($1,$2,'inbound','whatsapp','hi',null,null,'wa:1') id`,[leadId,contactId]);
assert.equal(r[0].id, m1, 'external_id dedupe');
console.log('✔ log_message dedupes on external_id');

// ---- delivered
r = await q(`select * from sales_mark_delivered($1,$2)`,[leadId,'https://final.vercel.app']);
assert.equal(r[0].status,'delivered');
console.log('✔ mark_delivered');

// ---- mark lost logic on a fresh lead with 2 contacts
r = await q(`select * from sales_upsert_lead($1::jsonb)`,[JSON.stringify({business_name:'Lost Co', google_place_id:'p50', phone:'919800000001'})]);
const l2=r[0].lead_id, c2a=r[0].contact_id;
r = await q(`select * from sales_upsert_lead($1::jsonb)`,[JSON.stringify({business_name:'Lost Co', google_place_id:'p50', phone:'919800000002'})]);
const c2b=r[0].contact_id;
await q(`select * from sales_mark_lost($1,$2)`,[l2,c2a]);
lead = await q(`select status from leads where id=$1`,[l2]);
assert.notEqual(lead[0].status,'lost','should NOT be lost while another contact is open');
await q(`select * from sales_mark_lost($1,$2)`,[l2,c2b]);
lead = await q(`select status from leads where id=$1`,[l2]);
assert.equal(lead[0].status,'lost','now all contacts declined');
console.log('✔ mark_lost only closes the lead when everyone declined');

console.log('\n✅ ALL SQL TESTS PASSED');
