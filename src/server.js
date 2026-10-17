#!/usr/bin/env node
// Nidum Local's local server (node N3): `node src/server.js`.
//
// Binds 127.0.0.1 only, on NIDUM_PORT or 47800, else the next free port.
// Writes session.json atomically right after listen() and before answering
// any request (Contracts §4); deletes it on SIGINT/SIGTERM and /api/quit.
//
// Environment:
//   NIDUM_HOME          state folder (default ~/.nidum-local)
//   NIDUM_PORT          first port to try (default 47800)
//   NIDUM_READ_ONLY=1   every mutation endpoint answers 403 FORBIDDEN
//   NIDUM_SAFE_MODE=1   create the Portless adapter with safeMode: true (tests, N6)
//
// The token is printed only to an interactive terminal: the launcher sends
// stdout to server.log, and the token must never be logged.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './api.js';
import { elevate as realElevate } from './elevate.js';
import { createPortless } from './portless.js';
import { VERSION, nidumHome, removeSession, writeSession } from './state.js';

export const DEFAULT_PORT = 47800;
const PORT_ATTEMPTS = 20;

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Listen on `start`, else the next free port (up to 20 tries), else any free port.
 * @returns {Promise<number>}
 */
export async function listenWithFallback(server, start, host = '127.0.0.1') {
  if (start === 0) return listenOnce(server, 0, host);
  for (let i = 0; i < PORT_ATTEMPTS && start + i <= 65535; i += 1) {
    try {
      return await listenOnce(server, start + i, host);
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
    }
  }
  return listenOnce(server, 0, host);
}

/**
 * Start the server.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.port]  first port to try (0 = any); default NIDUM_PORT or 47800
 * @param {string} [opts.home]  default NIDUM_HOME or ~/.nidum-local
 * @param {boolean} [opts.readOnly]  default NIDUM_READ_ONLY === '1'
 * @param {object} [opts.adapter]  default createPortless({ env, safeMode: NIDUM_SAFE_MODE === '1' })
 * @param {object} [opts.discovery]  default ./discovery.js
 * @param {object} [opts.network]  default ./network.js
 * @param {boolean} [opts.writeSession]  default true
 * @param {() => void} [opts.onQuit]  after /api/quit (default: close and exit 0)
 * @param {(msg: string) => void} [opts.log]
 * @param {object} [opts.app]  extra createApp options (intervals, probeRoute, hostCheck, lanMode, token, publicDir, …)
 */
export async function startServer(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || nidumHome(env);
  const readOnly = opts.readOnly ?? env.NIDUM_READ_ONLY === '1';
  const log = opts.log || ((msg) => console.error(`[${new Date().toISOString()}] ${msg}`));
  const hooks = { start: () => {}, end: () => {} };
  const adapter =
    opts.adapter ||
    createPortless({
      env,
      safeMode: env.NIDUM_SAFE_MODE === '1',
      elevate: async (argv, e, o) => {
        hooks.start();
        try {
          return await realElevate(argv, e, o);
        } finally {
          hooks.end();
        }
      },
    });
  const discovery = opts.discovery || (await import('./discovery.js'));
  const network = opts.network || (await import('./network.js'));

  let handle = null;
  const app = createApp({
    ...(opts.app || {}),
    adapter,
    discovery,
    network,
    home,
    readOnly,
    log,
    onQuit: () => {
      if (opts.onQuit) {
        handle.close().then(() => opts.onQuit(), () => opts.onQuit());
      } else {
        handle.close().finally(() => process.exit(0));
      }
    },
  });
  hooks.start = () => app.elevationStarted();
  hooks.end = () => app.elevationEnded();
  await app.init();

  const server = http.createServer((req, res) => {
    app.handle(req, res).catch((err) => {
      log(`unhandled request error: ${err?.stack || err}`);
      try {
        res.destroy();
      } catch {
        /* closed */
      }
    });
  });
  server.keepAliveTimeout = 5000;
  const envPort = env.NIDUM_PORT && /^\d+$/.test(env.NIDUM_PORT) ? Number(env.NIDUM_PORT) : null;
  const start = opts.port ?? (envPort !== null && envPort <= 65535 ? envPort : DEFAULT_PORT);
  let port;
  try {
    port = await listenWithFallback(server, start);
  } catch (err) {
    await app.close();
    throw err;
  }
  app.setPort(port);
  const startedAt = new Date().toISOString();
  if (opts.writeSession !== false) {
    try {
      writeSession(home, { port, token: app.token, pid: process.pid, startedAt, version: VERSION });
    } catch (err) {
      server.close();
      await app.close();
      throw err;
    }
  }
  app.markReady();
  app.live.warm().catch(() => {});

  let closing = null;
  handle = {
    port,
    token: app.token,
    home,
    url: `http://127.0.0.1:${port}/`,
    tokenUrl: `http://127.0.0.1:${port}/?t=${app.token}`,
    server,
    app,
    adapter,
    readOnly,
    startedAt,
    /** Stop: SSE clients, loops, device setup, the listener; remove session.json. */
    close() {
      if (!closing) {
        closing = (async () => {
          await app.close();
          await new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
          });
          if (opts.writeSession !== false) removeSession(home, process.pid);
        })();
      }
      return closing;
    },
  };
  return handle;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  let s = null;
  const shutdown = async (code = 0) => {
    try {
      if (s) await s.close();
    } finally {
      process.exit(code);
    }
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  process.on('unhandledRejection', (err) => console.error(`[${new Date().toISOString()}] unhandled rejection: ${err?.stack || err}`));
  try {
    s = await startServer({ onQuit: () => process.exit(0) });
    const mode = s.readOnly ? ' (read-only)' : '';
    if (process.stdout.isTTY) {
      console.log(`Nidum Local ${VERSION} is running${mode} at ${s.url}\nOpen: ${s.tokenUrl}`);
    } else {
      console.log(`Nidum Local ${VERSION} is running${mode} at ${s.url} (pid ${process.pid}; open it from the launcher)`);
    }
  } catch (err) {
    console.error(`Nidum Local couldn't start: ${err?.message || err}`);
    process.exit(1);
  }
}
