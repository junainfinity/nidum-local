// Fixture loading and a fake command runner for the N2 discovery/network tests.

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'discovery');

/** Reads `test/fixtures/discovery/<name>` as UTF-8. */
export function fixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/**
 * Fake `runCommand`. `routes` maps "<program basename> <args joined by spaces>"
 * (or a prefix of it) to a result: a string (stdout, exit 0), a partial result
 * object, or a function (file, args) → either. Unmatched calls fail like ENOENT.
 * Every call is recorded in `run.calls` as { file, args, timeout }.
 */
export function fakeRun(routes = {}) {
  const calls = [];
  const run = async (file, args, opts = {}) => {
    calls.push({ file, args: [...args], timeout: opts.timeout });
    const key = `${basename(file)} ${args.join(' ')}`;
    const match = Object.keys(routes)
      .filter((k) => key === k || key.startsWith(`${k} `) || key.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (match === undefined) {
      return { ok: false, code: null, stdout: '', stderr: '', error: `${file}: ENOENT`, timedOut: false };
    }
    let value = routes[match];
    if (typeof value === 'function') value = await value(file, args);
    if (value instanceof Error) throw value;
    if (typeof value === 'string') return { ok: true, code: 0, stdout: value, stderr: '', error: null, timedOut: false };
    const code = value.code ?? 0;
    return { ok: code === 0, code, stdout: value.stdout ?? '', stderr: value.stderr ?? '', error: value.error ?? null, timedOut: Boolean(value.timedOut) };
  };
  run.calls = calls;
  return run;
}

/** An `os.networkInterfaces()`-shaped object from [name, ip] pairs (plus loopback). */
export function fakeNics(pairs) {
  const nics = { lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };
  for (const [name, ip] of pairs) {
    (nics[name] ||= []).push({ address: ip, family: 'IPv4', internal: false });
    nics[name].push({ address: 'fe80::1', family: 'IPv6', internal: false });
  }
  return nics;
}
