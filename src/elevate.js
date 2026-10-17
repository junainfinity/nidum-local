// Runs one whole Portless command as root/Administrator through the OS's own
// password dialog (graph validation F6). Portless's built-in elevation spawns
// `sudo` with inherited stdio (cli.js:4463-4471, 6780-6812), which cannot work
// from a server without a TTY, so Nidum Local elevates the entire command instead.
//
//   macOS    osascript -e 'do shell script "<argv, shell-quoted>" with administrator privileges'
//   Linux    pkexec /usr/bin/env K=V … <argv>                     (experimental, fixture-tested)
//   Windows  powershell Start-Process cmd.exe -Verb RunAs -Wait   (experimental, fixture-tested)
//
// Nothing here uses a shell on the Nidum side: every process is started with
// execFile. The only shell string is the one handed to the elevated `/bin/sh`
// inside `do shell script`, and every word in it is single-quoted.

import { execFile as nodeExecFile } from 'node:child_process';
import { PortlessError } from './portless.js';

/** Default time allowed for the password dialog plus the command itself. */
export const ELEVATE_TIMEOUT_MS = 120000;

const CANCELLED_MESSAGE = 'Password not entered. Nothing changed.';

/**
 * POSIX single-quote one word for /bin/sh.
 * @param {string} word
 * @returns {string}
 */
export function shellQuote(word) {
  const s = String(word);
  if (s.includes('\0')) throw new TypeError('argument contains a NUL byte');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Escape a string for use inside an AppleScript double-quoted literal.
 * @param {string} s
 * @returns {string}
 */
export function appleScriptString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build `K=V` words in a stable order.
 * @param {Record<string, string>} env
 * @returns {string[]}
 */
function envWords(env) {
  return Object.entries(env)
    .filter(([k, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new TypeError(`invalid environment variable name: ${k}`);
      return `${k}=${v}`;
    });
}

/** Quote one word for cmd.exe (inside `cmd /d /s /c "…"`). */
function cmdQuote(word) {
  return `"${String(word).replace(/"/g, '""')}"`;
}

/**
 * Pure builder for the elevation process: what `elevate()` would execFile.
 * Exposed so tests can assert the exact command without elevating anything.
 *
 * @param {string[]} argv  the full command, argv[0] is the executable
 * @param {Record<string, string>} env  variables the elevated command must see
 * @param {{ platform?: NodeJS.Platform, prompt?: string }} [opts]
 * @returns {{ file: string, args: string[], script?: string, command?: string }}
 */
export function buildElevationCommand(argv, env, { platform = process.platform, prompt } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError('argv must be a non-empty array');
  const words = envWords(env || {});
  const all = [...words, ...argv].map(String);
  if (platform !== 'win32' && String(argv[0]).includes('=')) {
    // /usr/bin/env would read it as another VAR=value assignment.
    throw new TypeError('the executable path must not contain "="');
  }
  if (prompt !== undefined && (typeof prompt !== 'string' || /[\r\n\0]/.test(prompt))) {
    throw new TypeError('prompt must be a single line of text');
  }
  if (platform === 'darwin' && all.some((w) => /[\r\n]/.test(w))) {
    // AppleScript turns a raw CR into LF inside a string literal; refuse rather than change a value.
    throw new TypeError('arguments must not contain line breaks');
  }
  if (platform === 'win32' && all.some((w) => /[%!"\r\n]/.test(w))) {
    // cmd.exe expands %VAR% / !VAR! even inside quotes; there is no reliable escape on a command line.
    throw new TypeError('arguments must not contain %, !, " or line breaks on Windows');
  }
  if (platform === 'darwin') {
    // `2>&1` so Portless's stderr comes back in the result; `without altering
    // line endings` keeps \n (do shell script converts to \r by default).
    const command = ['/usr/bin/env', ...words, ...argv].map(shellQuote).join(' ') + ' 2>&1';
    const promptPart = prompt ? ` with prompt ${appleScriptString(prompt)}` : '';
    const script = `do shell script ${appleScriptString(command)}${promptPart} with administrator privileges without altering line endings`;
    return { file: '/usr/bin/osascript', args: ['-e', script], script, command };
  }
  if (platform === 'linux') {
    return { file: 'pkexec', args: ['/usr/bin/env', ...words, ...argv] };
  }
  if (platform === 'win32') {
    const sets = Object.entries(env || {}).map(([k, v]) => `set "${k}=${v}"`);
    const cmdLine = [...sets, argv.map(cmdQuote).join(' ')].join(' && ');
    const argList = `/d /s /c "${cmdLine}"`;
    const ps = [
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '${argList.replace(/'/g, "''")}'`,
      '-Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode',
    ].join(' ');
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', ps], command: cmdLine };
  }
  throw new PortlessError('UNSUPPORTED', `Administrator rights are not supported on ${platform}.`);
}

function execFileP(execFile, file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * Interpret the osascript result. `do shell script` reports failures as
 * "execution error: <text> (<status>)"; -128 means the dialog was cancelled.
 * @returns {{ cancelled: boolean, status: number | null, text: string }}
 */
export function parseOsascriptError(stderr) {
  const m = /execution error: ([\s\S]*?) \((-?\d+)\)\s*$/.exec(stderr || '');
  if (!m) return { cancelled: /User cancel+ed/i.test(stderr || ''), status: null, text: stderr || '' };
  const status = Number(m[2]);
  return { cancelled: status === -128, status, text: m[1] };
}

/**
 * Run `argv` as root/Administrator with exactly `env` added to its environment.
 * Injectable: tests pass a fake `execFile` (or replace `elevate` wholesale in
 * createPortless) and never elevate for real.
 *
 * @param {string[]} argv
 * @param {Record<string, string>} env
 * @param {{ timeout?: number, platform?: NodeJS.Platform, prompt?: string, execFile?: typeof nodeExecFile }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 * @throws {PortlessError} PERMISSION when the dialog is cancelled or refused,
 *   TIMEOUT when it takes longer than `timeout`, UNKNOWN (with `raw` and
 *   `details.exitCode`) when the elevated command itself fails.
 */
export async function elevate(argv, env, { timeout = ELEVATE_TIMEOUT_MS, platform = process.platform, prompt, execFile = nodeExecFile } = {}) {
  const { file, args } = buildElevationCommand(argv, env, { platform, prompt });
  const { error, stdout, stderr } = await execFileP(execFile, file, args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (!error) return { stdout, stderr };
  if (error.killed || error.code === 'ETIMEDOUT') {
    throw new PortlessError('TIMEOUT', 'This is taking longer than expected.', { raw: stdout + stderr });
  }
  if (error.code === 'ENOENT') {
    throw new PortlessError('UNSUPPORTED', `The administrator dialog tool (${file}) is not available.`, { raw: String(error.message) });
  }
  if (platform === 'darwin') {
    const parsed = parseOsascriptError(stderr);
    if (parsed.cancelled) throw new PortlessError('PERMISSION', CANCELLED_MESSAGE, { raw: stderr.trim() });
    throw new PortlessError('UNKNOWN', 'Something went wrong. Nothing was changed.', {
      raw: (stdout + parsed.text).trim(),
      details: { exitCode: parsed.status },
    });
  }
  if (platform === 'linux' && (error.code === 126 || error.code === 127)) {
    // pkexec: 126 = dialog dismissed, 127 = not authorized.
    throw new PortlessError('PERMISSION', CANCELLED_MESSAGE, { raw: (stdout + stderr).trim() });
  }
  if (platform === 'win32' && /cancel+ed by the user/i.test(stderr)) {
    throw new PortlessError('PERMISSION', CANCELLED_MESSAGE, { raw: stderr.trim() });
  }
  throw new PortlessError('UNKNOWN', 'Something went wrong. Nothing was changed.', {
    raw: (stdout + stderr).trim(),
    details: { exitCode: typeof error.code === 'number' ? error.code : null },
  });
}
