// Isolated Portless environment for tests (graph validation F8).
// Every Portless invocation in a test must use the env returned here.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './net.js';

const DELETED = [
  'PORTLESS_TLD', 'PORTLESS_LAN_IP', 'PORTLESS_WILDCARD', 'PORTLESS_TAILSCALE',
  'PORTLESS_FUNNEL', 'PORTLESS_NGROK', 'PORTLESS_APP_PORT',
];

/**
 * Creates a fresh state dir and picks a free proxy port ≥ 20000.
 * Start the proxy with: portless proxy start -p <port> --no-tls --tld local   (never --lan)
 * Stop it with:        portless proxy stop -p <port>, then call cleanup().
 * @returns {Promise<{ env: NodeJS.ProcessEnv, stateDir: string, port: number, cleanup: () => void }>}
 */
export async function portlessTestEnv() {
  const stateDir = mkdtempSync(join(tmpdir(), 'nidum-portless-'));
  const port = await freePort({ min: 20000 });
  const env = { ...process.env };
  for (const k of DELETED) delete env[k];
  Object.assign(env, {
    PORTLESS_STATE_DIR: stateDir,
    PORTLESS_SYNC_HOSTS: '0',
    PORTLESS_LAN: '0',
    PORTLESS_HTTPS: '0',
    PORTLESS_PORT: String(port),
    NO_COLOR: '1',
  });
  return { env, stateDir, port, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}
