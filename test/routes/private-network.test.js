import { describe, it, expect } from 'vitest';
import express from 'express';
import { corsMiddleware } from '../../src/Middleware/cors.js';
import { normalizeWebAccess } from '../../src/Configuration/ServiceOptions.js';

/**
 * Private Network Access preflight.
 *
 * A page served from a PUBLIC origin (cloud Odoo at https://7g.wine) calling a
 * PRIVATE address (this server on the shop LAN) is blocked by Chrome unless the
 * PREFLIGHT carries Access-Control-Allow-Private-Network.
 *
 * Two separate bugs have produced the same symptom — "fiscal print server is not
 * reachable" from the POS while the server's own web UI worked — and both are
 * covered here:
 *
 *   1. the header was set in a middleware registered AFTER the one that
 *      short-circuits OPTIONS, so it never reached a preflight;
 *   2. the option was read as WebAccess.EnablePrivateNetwork while the server's
 *      web UI saved it as enablePrivateNetwork, so a box whose tickbox was on
 *      still sent no header.
 *
 * This imports the real middleware. The earlier version of this test built its
 * own copy, which stayed correct while the shipped one was fed a key it could
 * not read — the suite passed straight through a live outage.
 */
const buildCorsApp = (webAccess) => {
  const app = express();
  app.use(corsMiddleware(webAccess));
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
    const res = await preflight(buildCorsApp({ EnablePrivateNetwork: true }));
    expect(res.status).toBe(200);
    expect(res.pna).toBe('true');
  });

  it('omits it when the option is off', async () => {
    const res = await preflight(buildCorsApp({ EnablePrivateNetwork: false }));
    expect(res.status).toBe(200);
    expect(res.pna).toBeNull();
  });

  // The Sofia box, verbatim: written by the server's own web UI.
  it('honours the camelCase spelling the web UI writes', async () => {
    const res = await preflight(buildCorsApp({ allowedOrigins: [], enablePrivateNetwork: true }));
    expect(res.status).toBe(200);
    expect(res.pna).toBe('true');
  });

  it('omits it when there is no WebAccess block at all', async () => {
    const res = await preflight(buildCorsApp(undefined));
    expect(res.status).toBe(200);
    expect(res.pna).toBeNull();
  });
});

describe('normalizeWebAccess', () => {
  it('accepts either casing and always answers in PascalCase', () => {
    expect(normalizeWebAccess({ enablePrivateNetwork: true, allowedOrigins: ['https://7g.wine'] }))
      .toEqual({ EnablePrivateNetwork: true, AllowedOrigins: ['https://7g.wine'] });
    expect(normalizeWebAccess({ EnablePrivateNetwork: true, AllowedOrigins: [] }))
      .toEqual({ EnablePrivateNetwork: true, AllowedOrigins: [] });
  });

  it('fills the defaults for a partial or absent block', () => {
    expect(normalizeWebAccess({ enablePrivateNetwork: true }))
      .toEqual({ EnablePrivateNetwork: true, AllowedOrigins: [] });
    expect(normalizeWebAccess(undefined))
      .toEqual({ EnablePrivateNetwork: false, AllowedOrigins: [] });
    expect(normalizeWebAccess(null))
      .toEqual({ EnablePrivateNetwork: false, AllowedOrigins: [] });
  });
});
