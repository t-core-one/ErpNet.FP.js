import { normalizeWebAccess } from '../Configuration/ServiceOptions.js';

/**
 * CORS, including the Private Network Access preflight.
 *
 * A page served from a PUBLIC origin (the cloud Odoo at https://7g.wine) that
 * calls a PRIVATE address (this box on the shop LAN) is blocked by Chrome unless
 * the PREFLIGHT carries Access-Control-Allow-Private-Network — and the preflight
 * is exactly the OPTIONS request short-circuited at the end of this middleware.
 * Setting the header in a later middleware, as the service originally did, meant
 * it never reached a preflight: simple GETs still worked, every POST failed, and
 * the POS reported the server unreachable while the server's own web UI —
 * same-origin, no preflight — worked fine.
 *
 * This lives in its own module because the test for that bug used to build its
 * own copy of the middleware. The copy stayed correct while the real one was
 * fed a config key it could not read, so the suite passed through a live outage.
 * One implementation, imported by both, cannot drift that way again.
 */
export function corsMiddleware(rawWebAccess) {
  const webAccess = normalizeWebAccess(rawWebAccess);
  return (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (webAccess.EnablePrivateNetwork) {
      res.header('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  };
}
