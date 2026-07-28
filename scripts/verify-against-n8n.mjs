#!/usr/bin/env node
/**
 * Verifies every node type + typeVersion in /workflows against a real
 * `n8n-nodes-base` install, so the JSON can't reference a node version
 * that n8n doesn't actually ship.
 *
 *   npm i -D n8n-nodes-base && node scripts/verify-against-n8n.mjs
 *
 * Skips cleanly when the package isn't installed (it's a ~200 MB dep, so
 * it's optional rather than part of the default dev install).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let NB;
try {
  NB = dirname(require.resolve('n8n-nodes-base/package.json'));
} catch {
  console.log('⚠ n8n-nodes-base not installed — skipping node-version verification.');
  console.log('  npm i -D n8n-nodes-base');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(NB, 'package.json'), 'utf8'));

const walk = (d) => {
  let out = [];
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
};

// node type name -> set of supported typeVersions
const registry = new Map();
for (const rel of pkg.n8n.nodes) {
  const main = join(NB, rel);
  if (!existsSync(main)) continue;
  const vers = new Set();
  let typeName = null;
  for (const f of walk(dirname(main))) {
    const src = readFileSync(f, 'utf8');
    const nm = src.match(/name:\s*'([a-zA-Z0-9_]+)'[\s\S]{0,200}?(?:icon|group|iconUrl|subtitle)/);
    if (nm && !typeName) typeName = nm[1];
    for (const m of src.matchAll(/version:\s*\[([^\]]*)\]/g))
      m[1].split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n)).forEach((v) => vers.add(v));
    for (const m of src.matchAll(/version:\s*([0-9]+(?:\.[0-9]+)?)\s*[,\n}]/g)) vers.add(Number(m[1]));
    for (const m of src.matchAll(/(\d+(?:\.\d+)?):\s*new \w+\(baseDescription\)/g)) vers.add(Number(m[1]));
  }
  const base = rel.split('/').pop().replace(/\.node\.js$/, '');
  const key = typeName || base.charAt(0).toLowerCase() + base.slice(1);
  const prev = registry.get(key) || new Set();
  vers.forEach((v) => prev.add(v));
  registry.set(key, prev);
}

let bad = 0, checked = 0;
const reported = new Set();
for (const f of readdirSync(join(R, 'workflows')).filter((x) => x.endsWith('.json'))) {
  const wf = JSON.parse(readFileSync(join(R, 'workflows', f), 'utf8'));
  for (const n of wf.nodes) {
    const key = n.type.replace('n8n-nodes-base.', '');
    checked++;
    const vers = registry.get(key);
    if (!vers?.size) continue;
    if (!vers.has(n.typeVersion)) {
      console.error(`✖ ${key} v${n.typeVersion} — supported [${[...vers].sort((a, b) => a - b).join(', ')}]  (${f} :: ${n.name})`);
      bad++;
    } else if (!reported.has(key)) {
      console.log(`✔ ${key.padEnd(18)} v${n.typeVersion}`);
      reported.add(key);
    }
  }
}
console.log(`\n${bad ? '✖' : '✔'} ${checked} node instances vs n8n-nodes-base ${pkg.version} — ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
