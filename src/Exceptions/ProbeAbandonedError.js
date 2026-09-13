import { FiscalPrinterException } from './FiscalPrinterException.js';

/**
 * Raised at an exchange whose channel lease has been revoked — i.e. at a probe
 * that detection has already given up on, the moment it tries to touch the port
 * again.
 *
 * It exists because a JS promise cannot be cancelled. Detection races each
 * driver against a 5s timeout and moves on, but the abandoned driver.connect()
 * kept running: an ISL probe re-wrote its frame twice more and polled the shared
 * receive buffer for ~15s (an ICP probe, which issues eight exchanges per
 * getRawDeviceInfo, for far longer), stealing the answer meant for whichever
 * driver was being tried next. Revoking the lease turns that silent theft into
 * this error, which unwinds the straggler's retry loop at its very next write()
 * or read().
 *
 * Nothing surfaces it to the POS: by construction nobody is waiting for the
 * answer any more, so Provider logs it at debug like any other failed probe.
 */
export class ProbeAbandonedError extends FiscalPrinterException {
  constructor(message) {
    super(message || 'Channel lease revoked: this exchange was abandoned');
    this.name = 'ProbeAbandonedError';
    this.abandoned = true;
  }
}

/** The error a signal was aborted with, or a fresh one for a signal aborted elsewhere. */
export function abandonedError(signal) {
  const reason = signal && signal.reason;
  return reason instanceof ProbeAbandonedError
    ? reason
    : new ProbeAbandonedError(reason && reason.message);
}

/**
 * Refuse to start any device I/O for a revoked lease. Called at the top of every
 * channel write() and read(): the cheapest possible cancellation point, and the
 * one that guarantees an abandoned probe emits no further frames.
 */
export function throwIfAbandoned(signal) {
  if (signal && signal.aborted) throw abandonedError(signal);
}
