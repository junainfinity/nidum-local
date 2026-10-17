// A fake Portless install for tests that must never execute the real CLI
// (elevation, safe mode, destructive wrappers, run() error mapping).
//
// The fake `portless` is a Node script (shebang = the Node running the tests).
// It appends one JSON line per invocation to $FAKE_RECORD (argv + selected env),
// then honours:
//   FAKE_STDOUT / FAKE_STDERR  text to print (may contain ANSI escapes)
//   FAKE_EXIT                  exit code (default 0)
//   FAKE_SLEEP_MS              sleep before exiting (to exercise timeouts)

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = `
const fs = require('node:fs');
const rec = process.env.FAKE_RECORD;
if (rec) {
  const env = {};
  for (const k of Object.keys(process.env)) if (k.startsWith('PORTLESS_') || k === 'NO_COLOR' || k === 'FORCE_COLOR') env[k] = process.env[k];
  fs.appendFileSync(rec, JSON.stringify({ script: process.argv[1], argv: process.argv.slice(2), env }) + '\\n');
}
if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
const code = Number(process.env.FAKE_EXIT || 0);
const ms = Number(process.env.FAKE_SLEEP_MS || 0);
setTimeout(() => process.exit(code), ms);
`;

/**
 * Create a fake install in a fresh temp dir.
 * `install.launcherPath` is a symlink to `install.binPath`, like Homebrew's.
 * @returns {{ install: { binPath: string, launcherPath: string, packageRoot: string, version: string, nodePath: string }, dir: string, record: string, calls: () => Array<{ script: string, argv: string[], env: Record<string,string> }>, cleanup: () => void }}
 */
export function createFakePortless() {
  const dir = mkdtempSync(join(tmpdir(), 'nidum-fake-portless-'));
  const packageRoot = join(dir, 'portless');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'portless', version: '0.0.0-fake' }));
  writeFileSync(join(packageRoot, 'dist', 'index.js'), 'export {};\n');
  const binPath = join(packageRoot, 'dist', 'cli.cjs');
  writeFileSync(binPath, `#!${process.execPath}\n${SCRIPT}`);
  chmodSync(binPath, 0o755);
  mkdirSync(join(dir, 'bin'));
  const launcherPath = join(dir, 'bin', 'portless');
  symlinkSync(binPath, launcherPath); // like /opt/homebrew/bin/portless → …/dist/cli.js
  const record = join(dir, 'calls.jsonl');
  return {
    install: { binPath, launcherPath, packageRoot, version: '0.0.0-fake', nodePath: process.execPath },
    dir,
    record,
    calls: () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
