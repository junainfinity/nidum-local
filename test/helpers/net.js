// Small network helpers shared by all tests.

import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AVOID = new Set([80, 443, 1355, 47800]);

/** Free TCP port on 127.0.0.1, at least `min`, never 80/443/1355/47800. */
export async function freePort({ min = 20000 } = {}) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = min + Math.floor(Math.random() * (60000 - min));
    if (AVOID.has(port)) continue;
    const ok = await new Promise((resolve) => {
      const srv = createTcpServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error('freePort: no free port found');
}

/** Throwaway HTTP server answering every request with an HTML page titled `title`. */
export async function startThrowawayHttp({ title = 'Throwaway', body = 'hello from throwaway' } = {}) {
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>${title}</title><p>${body}</p>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** Throwaway raw TCP server that never speaks HTTP. close() resolves even with clients connected. */
export async function startThrowawayTcp() {
  const sockets = new Set();
  const server = createTcpServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.resume(); // drain client bytes so the socket can finish closing
    sock.end('\x00\x01binary');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(r);
    }),
  };
}

/** Runs fn(dir) with a fresh temp dir, removed afterwards. */
export async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
