// Nidum Local dashboard — API client (Contracts §4–§8).
//
// Same-origin fetch with the session cookie. Errors become ApiError with the
// server's { code, message, details?, raw? }. 503 STATE_UNREADABLE is retried
// once after 1 s (Contracts §7). A failed connection is code 'OFFLINE'.

export class ApiError extends Error {
  constructor(code, message, { status = 0, details, raw } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
    if (raw !== undefined) this.raw = raw;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Plain-language text for codes whose server message is too technical (design spec §10 error map). */
const FRIENDLY = {
  PERMISSION: 'Password not entered. Nothing changed.',
  TIMEOUT: 'This is taking longer than expected.',
  CLI_MISSING: 'Portless isn’t installed anymore. Open the launcher again.',
  OFFLINE: 'Lost contact with Nidum Local.',
  UNAUTHORIZED: 'Open Nidum Local from its launcher again.',
};

/** The message to show for an error. */
export function errorText(err) {
  if (!err) return '';
  if (FRIENDLY[err.code]) return FRIENDLY[err.code];
  return err.message || 'Something went wrong. Nothing was changed.';
}

async function once(method, path, body, timeoutMs) {
  const init = { method, headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  init.signal = ctl.signal;
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    clearTimeout(timer);
    if (ctl.signal.aborted) throw new ApiError('TIMEOUT', FRIENDLY.TIMEOUT);
    throw new ApiError('OFFLINE', FRIENDLY.OFFLINE);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const e = data && data.error ? data.error : { code: res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL', message: '' };
    throw new ApiError(e.code || 'INTERNAL', e.message || FRIENDLY[e.code] || 'Something went wrong. Nothing was changed.', { status: res.status, details: e.details, raw: e.raw });
  }
  return data;
}

/**
 * Call the API. `opts.timeout` in ms (default 30 s: password dialogs take time).
 * @returns {Promise<any>}
 */
export async function api(method, path, body, opts = {}) {
  // Spec §9 asks for a short client timeout; 10 s covers the server's own 5 s dependency deadlines.
  // Calls that wait for an OS password dialog (tools) pass a longer one.
  const timeout = opts.timeout ?? 10000;
  try {
    return await once(method, path, body, timeout);
  } catch (e) {
    if (e.code === 'STATE_UNREADABLE') {
      await sleep(opts.retryDelay ?? 1000);
      return once(method, path, body, timeout);
    }
    throw e;
  }
}

export const enc = (s) => encodeURIComponent(s);
