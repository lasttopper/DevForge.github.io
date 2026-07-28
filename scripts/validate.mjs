#!/usr/bin/env node
/**
 * Structural validation of the generated workflow JSON.
 * Catches the mistakes that only show up as a red node after import:
 *   - connections pointing at nodes that don't exist
 *   - orphaned nodes (no inbound edge and not a trigger)
 *   - duplicate node names / ids
 *   - $('Node Name') expressions referencing a missing node
 *   - Code nodes with syntax errors
 *   - non-JSON `jsonBody` templates
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'workflows');

const TRIGGERS = [
  'scheduleTrigger', 'webhook', 'manualTrigger', 'emailReadImap',
  'cron', 'interval', 'executeWorkflowTrigger', 'errorTrigger', 'formTrigger',
];
const isTrigger = (t) => TRIGGERS.some((x) => t.endsWith('.' + x));
const isSticky = (t) => t.endsWith('.stickyNote');

let errors = 0;
let warnings = 0;
const err = (f, m) => { console.error(`  ✖ [${f}] ${m}`); errors++; };
const warn = (f, m) => { console.warn(`  ⚠ [${f}] ${m}`); warnings++; };

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const wf = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  console.log(`\n${file}  —  "${wf.name}"`);

  const names = new Set();
  const ids = new Set();

  for (const n of wf.nodes) {
    if (names.has(n.name)) err(file, `duplicate node name "${n.name}"`);
    names.add(n.name);
    if (ids.has(n.id)) err(file, `duplicate node id on "${n.name}"`);
    ids.add(n.id);
    if (!Array.isArray(n.position) || n.position.length !== 2) {
      err(file, `bad position on "${n.name}"`);
    }
    if (typeof n.typeVersion !== 'number') err(file, `missing typeVersion on "${n.name}"`);
  }

  // --- connections reference real nodes ---
  const targeted = new Set();
  for (const [src, conn] of Object.entries(wf.connections)) {
    if (!names.has(src)) err(file, `connection from unknown node "${src}"`);
    for (const branch of conn.main ?? []) {
      for (const link of branch ?? []) {
        if (!names.has(link.node)) err(file, `"${src}" → unknown node "${link.node}"`);
        targeted.add(link.node);
      }
    }
  }

  // --- orphans ---
  for (const n of wf.nodes) {
    if (isSticky(n.type) || isTrigger(n.type)) continue;
    if (!targeted.has(n.name)) err(file, `orphan node (no input): "${n.name}"`);
  }

  // --- dead-end check (informational) ---
  // These are deliberate end-of-branch nodes: they either stop the flow on
  // purpose or hand off to another workflow.
  const TERMINAL = /Complete|Nothing To Do|Ignore|Preview Only|Duplicate Webhook|Manual Build Queue|Already Has Prototype|^📝 Log |^🚀 Trigger |^💳 Trigger |^🚫 Mark Lost|^🔔 Alert Me|200 OK \(ignored\)/;
  for (const n of wf.nodes) {
    if (isSticky(n.type)) continue;
    if (!wf.connections[n.name] && !TERMINAL.test(n.name)) {
      warn(file, `node has no output connection: "${n.name}"`);
    }
  }

  // --- expression + code checks ---
  const walk = (val, path, cb) => {
    if (typeof val === 'string') cb(val, path);
    else if (Array.isArray(val)) val.forEach((v, i) => walk(v, `${path}[${i}]`, cb));
    else if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) walk(v, `${path}.${k}`, cb);
    }
  };

  for (const n of wf.nodes) {
    // $('Some Node') must exist
    walk(n.parameters, n.name, (s) => {
      for (const m of s.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) {
        if (!names.has(m[1])) err(file, `"${n.name}" references missing node $('${m[1]}')`);
      }
      for (const m of s.matchAll(/\$node\["([^"]+)"\]/g)) {
        if (!names.has(m[1])) err(file, `"${n.name}" references missing node $node["${m[1]}"]`);
      }
    });

    // Code node syntax
    if (n.type.endsWith('.code') && n.parameters?.jsCode) {
      try {
        new vm.Script(`(async () => { ${n.parameters.jsCode} })`);
      } catch (e) {
        err(file, `syntax error in Code node "${n.name}": ${e.message}`);
      }
    }

    // jsonBody must be a valid JSON template
    if (n.parameters?.jsonBody) {
      const body = String(n.parameters.jsonBody).replace(/^=/, '');
      // replace {{ ... }} with a placeholder literal, then JSON.parse
      const stubbed = body.replace(/\{\{[\s\S]*?\}\}/g, '"__EXPR__"');
      try {
        JSON.parse(stubbed);
      } catch (e) {
        err(file, `jsonBody of "${n.name}" is not valid JSON: ${e.message}`);
      }
      // balanced braces inside expressions
      for (const m of body.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
        const inner = m[1];
        const open = (inner.match(/\(/g) || []).length;
        const close = (inner.match(/\)/g) || []).length;
        if (open !== close) err(file, `unbalanced parens in expression of "${n.name}": ${inner.trim().slice(0, 70)}`);
      }
    }
  }

  // --- switch outputs must all be wired ---
  for (const n of wf.nodes.filter((x) => x.type.endsWith('.switch'))) {
    const rules = n.parameters?.rules?.values?.length ?? 0;
    const extra = n.parameters?.options?.fallbackOutput === 'extra' ? 1 : 0;
    const wired = wf.connections[n.name]?.main?.length ?? 0;
    if (wired < rules + extra) {
      warn(file, `switch "${n.name}" has ${rules + extra} outputs but only ${wired} wired`);
    }
  }

  // --- if nodes should wire both branches ---
  for (const n of wf.nodes.filter((x) => x.type.endsWith('.if'))) {
    const wired = wf.connections[n.name]?.main ?? [];
    if (wired.length < 2 || !wired[1]?.length) {
      warn(file, `if "${n.name}" has no false-branch connection`);
    }
  }

  const real = wf.nodes.filter((n) => !isSticky(n.type)).length;
  console.log(`  ${real} nodes, ${wf.nodes.length - real} notes, ${Object.keys(wf.connections).length} connected`);
}

console.log(`\n${errors ? '✖' : '✔'} ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
