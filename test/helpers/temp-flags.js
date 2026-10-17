// Real `chflags uchg` for the E13 tests (node N1), on the suite's own temp
// dirs only (`nidum-portless-*` directly under os.tmpdir()). Every flag set
// here is cleared again: by the test's own finally, by `unlockAll()` in the
// suite's after hook, and, if the run dies or is killed (a test timeout, Ctrl-C,
// an outer `kill`), by the exit/signal handlers installed on first use. The
// real ~/.portless is refused outright. `schg` needs root and is never set.
// Every clear re-checks its path first (validation 6 F4): a flagged path whose
// folder was since swapped for a symlink is skipped, never followed. A file with
// more than one hard link is refused for both set and clear (validation 7 F3):
// its inode may also sit outside our dirs (the real routes.json, say), where a
// path check can't see it.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const CHFLAGS = '/usr/bin/chflags';
const FIND = '/usr/bin/find';
/** Every path flagged and not yet cleared → the resolved temp root it was flagged under. */
export const flagged = new Map();
/** Every temp root a flag was set under (cleared recursively at the end). */
const roots = new Set();
let handlersInstalled = false;

/**
 * Throw unless `p` is inside `root`, `root` is one of our `nidum-portless-*`
 * temp dirs (never ~/.portless), and `p` (when not a folder) has exactly one
 * hard link: a second link may be outside every root (validation 7 F3).
 */
export function assertOwnTemp(p, root) {
  const tmp = realpathSync(tmpdir());
  const r = realpathSync(root);
  const real = realpathSync(p);
  if (!(r.startsWith(`${tmp}/nidum-portless-`) && !r.slice(tmp.length + 1).includes('/'))) throw new Error(`not one of our temp dirs: ${r}`);
  if (!(real === r || real.startsWith(`${r}/`))) throw new Error(`outside the temp dir: ${real}`);
  const realPortless = join(homedir(), '.portless');
  const resolved = existsSync(realPortless) ? realpathSync(realPortless) : realPortless;
  if (real.startsWith(realPortless) || real.startsWith(resolved)) throw new Error('never the real ~/.portless');
  const st = lstatSync(real);
  if (!st.isDirectory() && st.nlink !== 1) throw new Error(`hard-linked elsewhere too (nlink ${st.nlink}): ${real}`);
}

/** `r` is (still) one of our temp roots: a real directory, not a link, named `nidum-portless-*` directly under the resolved tmpdir. */
function isOurRoot(r) {
  try {
    const tmp = realpathSync(tmpdir());
    const st = lstatSync(r);
    return st.isDirectory() && !st.isSymbolicLink() && realpathSync(r) === r && r.startsWith(`${tmp}/nidum-portless-`) && !r.slice(tmp.length + 1).includes('/');
  } catch {
    return false;
  }
}

/**
 * `p` (a resolved path stored when it was flagged) is still the same place:
 * inside our root `root`, not ~/.portless (assertOwnTemp), it resolves to
 * itself, and no component from the root down is a symlink (lstat each one).
 * False on any doubt: the caller then skips it.
 */
export function stillOurs(p, root) {
  try {
    if (!isOurRoot(root)) return false;
    assertOwnTemp(p, root);
    if (realpathSync(p) !== p) return false;
    const rel = relative(root, p);
    if (rel.startsWith('..')) return false;
    let cur = root;
    for (const part of rel ? rel.split(sep) : []) {
      cur = join(cur, part);
      if (lstatSync(cur).isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', () => unlockAll());
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      unlockAll();
      process.kill(process.pid, sig); // default action now that this listener is gone
    });
  }
}

/** `chflags uchg|nouchg <p>` on a path inside one of our temp roots (resolved through symlinks first). */
export function chflagsTemp(flag, p, root) {
  if (flag !== 'uchg' && flag !== 'nouchg') throw new Error('only uchg/nouchg (schg needs root)');
  assertOwnTemp(p, root);
  installHandlers();
  const real = realpathSync(p);
  const realRoot = realpathSync(root);
  if (flag === 'uchg') {
    flagged.set(real, realRoot);
    roots.add(realRoot);
  }
  // -h: never follow a last component that was swapped for a link meanwhile.
  execFileSync(CHFLAGS, ['-h', flag, real], { timeout: 5000 });
  if (flag === 'nouchg') flagged.delete(real);
}

/**
 * Clear every flag set here, best effort per path, then a recursive pass over
 * each temp root that clears `uchg` on every folder and every single-link file
 * (`find -P <root> ( -type d -o -links 1 ) -flags +uchg`, no symlink following),
 * so nothing flagged can survive into the temp-dir removal. A file with more
 * than one link is left alone: its inode may be outside our dirs (validation 7
 * F3); the temp-dir removal then fails loudly instead. Synchronous: safe in 'exit'.
 * Each stored path and root is re-checked first (`stillOurs` / `isOurRoot`)
 * and skipped when it no longer passes; a skipped path stays in `flagged`, so
 * the suite's size check reports it. (The flagged entry itself, moved within
 * the root, is still cleared by the recursive pass.)
 */
export function unlockAll() {
  for (const [p, root] of [...flagged]) {
    if (!existsSync(p) && !isSymlink(p)) {
      flagged.delete(p);
      continue;
    }
    if (!stillOurs(p, root)) continue;
    try {
      execFileSync(CHFLAGS, ['-h', 'nouchg', p], { timeout: 5000 });
      flagged.delete(p);
    } catch {
      /* reported by the caller's size check */
    }
  }
  for (const r of [...roots]) {
    try {
      if (isOurRoot(r)) {
        execFileSync(FIND, ['-P', r, '(', '-type', 'd', '-o', '-links', '1', ')', '-flags', '+uchg', '-exec', CHFLAGS, '-h', 'nouchg', '{}', '+'], { timeout: 10000, stdio: 'ignore' });
      }
    } catch {
      /* best effort; reported by the caller's size check */
    }
  }
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
