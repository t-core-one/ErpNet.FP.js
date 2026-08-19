import { describe, it, expect } from 'vitest';
import express from 'express';

/**
 * Private Network Access preflight.
 *
 * A page served from a PUBLIC origin (cloud Odoo at https://7g.wine) calling a
 * PRIVATE address (this server on the shop LAN) is blocked by Chrome unless the
 * PREFLIGHT carries Access-Control-Allow-Private-Network. The header used to be
 * set in a middleware registered AFTER the one that short-circuits OPTIONS, so
 * it never reached a preflight: simple GETs still worked, every POST failed, and
 * the POS reported "fiscal print server is not reachable" while the server's own
 * web UI — same origin, no preflight — worked fine.
 */
const buildCorsApp = (enablePrivateNetwork) => {
  const app = express();
  const webAccess = { EnablePrivateNetwork: enablePrivateNetwork };
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (webAccess.EnablePrivateNetwork) {
      res.header('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
  app.post('/printers/:id/deposit', (_req, res) => res.json({ ok: true }));
  return app;
};

const preflight = (app) => new Promise((resolve) => {
  const server = app.listen(0, async () => {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/printers/DT408090/deposit`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://7g.wine',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    resolve({ status: res.status, pna: res.headers.get('access-control-allow-private-network') });
    server.close();
  });
});

describe('CORS preflight for a private-network POST', () => {
  it('carries Access-Control-Allow-Private-Network when enabled', async () => {
    const res = await preflight(buildCorsApp(true));
    expect(res.status).toBe(200);
    expect(res.pna).toBe('true');
  });

  it('omits it when the option is off', async () => {
    const res = await preflight(buildCorsApp(false));
    expect(res.status).toBe(200);
    expect(res.pna).toBeNull();
  });
});
