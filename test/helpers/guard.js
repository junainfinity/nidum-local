// Safety guard: fingerprints the user's real Portless and Nidum Local state so any
// test or agent run that touches it is caught. See docs/Nidum Local/Plan/Engineering graph.md.
//
//   node test/helpers/guard.js record <baseline.json>   save a fingerprint
//   node test/helpers/guard.js check  <baseline.json>   exit 1 and list differences on any change
//
// Excluded on purpose: ~/.portless/proxy.lan (the root proxy rewrites it on IP changes),
// *.log files and routes.lock.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const PORTLESS_FILES = [
  'routes.json', 'ca.pem', 'ca-key.pem', 'ca.trusted', 'server.pem', 'server-key.pem',
  'proxy.port', 'proxy.pid', 'proxy.tld', 'proxy.tlds', 'proxy.tls',
].map((f) => join(HOME, '.portless', f));
const SYSTEM_FILES = ['/etc/hosts', '/Library/LaunchDaemons/sh.portless.proxy.plist'];
const NIDUM_HOME = join(HOME, '.nidum-local');

function hashFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (err) {
    return err.code === 'ENOENT' ? 'missing' : `unreadable:${err.code}`;
  }
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (!entry.endsWith('.log')) out.push(full);
  }
  return out;
}

/** @returns {Record<string, string>} path → sha256 (or 'missing') */
export function snapshot() {
  const snap = {};
  for (const f of [...PORTLESS_FILES, ...SYSTEM_FILES]) snap[f] = hashFile(f);
  snap[NIDUM_HOME] = existsSync(NIDUM_HOME) ? 'present' : 'missing';
  for (const f of walk(NIDUM_HOME)) snap[f] = hashFile(f);
  return snap;
}

/** @returns {string[]} human-readable differences; empty when identical */
export function compare(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs = [];
  for (const k of keys) {
    if (before[k] !== after[k]) diffs.push(`${k}: ${before[k] ?? 'absent'} → ${after[k] ?? 'absent'}`);
  }
  return diffs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  if (!file || !['record', 'check'].includes(cmd)) {
    console.error('usage: node test/helpers/guard.js record|check <baseline.json>');
    process.exit(2);
  }
  if (cmd === 'record') {
    writeFileSync(file, JSON.stringify(snapshot(), null, 2));
    console.log(`guard: baseline recorded to ${file}`);
  } else {
    const diffs = compare(JSON.parse(readFileSync(file, 'utf8')), snapshot());
    if (diffs.length) {
      console.error('guard: REAL STATE CHANGED\n' + diffs.join('\n'));
      process.exit(1);
    }
    console.log('guard: real state unchanged');
  }
}
