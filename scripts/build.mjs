#!/usr/bin/env node
/**
 * Regenerates every workflow JSON in /workflows.
 *   node scripts/build.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import wf1 from './build/wf1-discovery.mjs';
import wf2 from './build/wf2-replies.mjs';
import wf3 from './build/wf3-prototype.mjs';
import wf4 from './build/wf4-payment.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'workflows');
mkdirSync(outDir, { recursive: true });

const targets = [
  ['01-lead-discovery-outreach.json', wf1],
  ['02-reply-listener-lock.json', wf2],
  ['03-prototype-and-payment.json', wf3],
  ['04-payment-webhook-delivery.json', wf4],
];

let nodes = 0;
for (const [file, build] of targets) {
  const wf = build();
  const json = wf.toJSON();
  writeFileSync(join(outDir, file), JSON.stringify(json, null, 2) + '\n');
  nodes += json.nodes.length;
  console.log(`✔ ${file.padEnd(36)} ${String(json.nodes.length).padStart(3)} nodes`);
}
console.log(`\n${targets.length} workflows, ${nodes} nodes total → workflows/`);
