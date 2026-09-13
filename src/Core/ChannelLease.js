import { ProbeAbandonedError, throwIfAbandoned } from '../Exceptions/ProbeAbandonedError.js';

/**
 * A revocable handle on a channel — the only handle a printer ever gets.
 *
 * WHY THIS EXISTS. Detection shares one channel across every driver probe on an
 * address (closing and reopening between drivers causes OS port-lock contention
 * on Linux) and races each probe against a 5s timeout. A promise cannot be
 * cancelled, so the abandoned probe kept going on that shared channel: it
 * re-wrote its frame on every remaining retry and polled the shared receive
 * buffer for the rest of its budget. It therefore stole the device's answer from
 * whichever driver was being tried next: an FP-800 on the third driver in the
 * list reported "Printers found: 0" repeatedly while answering the port
 * perfectly, and the stragglers were still writing to the very channel a freshly
 * detected printer was about to use for live fiscal traffic.
 *
 * WHAT THIS IS NOT. It is not a lock. Nothing ever waits for a straggler to
 * finish. Making the channel mutually exclusive was tried once: the abandoned
 * probe held the mutex, every driver after it timed out waiting for it, and
 * NOTHING was detected — six minutes of a live shop with no fiscal printer. A
 * lease is the inverse of that mutex. The newcomer does not queue behind the
 * straggler, it revokes the straggler; revoke() is synchronous, takes no locks
 * and never blocks. Every operation here either starts immediately or throws
 * immediately, so there is nothing to hold and nothing to wait on.
 *
 * The lease is deliberately the CHANNEL argument of driver.connect() rather than
 * a fifth parameter: drivers touch the device only through channel.write() and
 * channel.read(), so handing them a revocable channel reaches all four send
 * paths without editing ten drivers — and, more to the point, without any way
 * for a driver to opt out of cancellation by forgetting to pass a signal along.
 */
export class ChannelLease {
  /**
   * @param {object} channel the underlying ComChannel / TcpChannel / HttpChannel
   * @param {string} [label] appears in the abandonment error, e.g. "bg.dt.c.isl @ /dev/ttyUSB0"
   */
  constructor(channel, label = '') {
    this._channel = channel;
    this._label = label || (channel && channel.descriptor) || 'channel';
    this._controller = new AbortController();
  }

  /** Drivers key their device-info cache on this, so it must read through. */
  get descriptor() {
    return this._channel.descriptor;
  }

  /** The token handed down to the channel, and to anything else cancellable. */
  get signal() {
    return this._controller.signal;
  }

  get revoked() {
    return this._controller.signal.aborted;
  }

  /** The channel underneath — for the transport's own bookkeeping, never for I/O. */
  get channel() {
    return this._channel;
  }

  async write(data) {
    throwIfAbandoned(this._controller.signal);
    // Purge before transmitting. Whatever is in the receive buffer arrived
    // before this command was sent, so it cannot be this command's answer: it is
    // a previous attempt's late reply, or an abandoned probe's. Serving it to
    // this exchange would be silent — no driver checks the SEQ or CMD echo.
    if (typeof this._channel.purgeInput === 'function') this._channel.purgeInput();
    await this._channel.write(data, this._controller.signal);
  }

  async read() {
    throwIfAbandoned(this._controller.signal);
    return this._channel.read(this._controller.signal);
  }

  /**
   * Give up on this exchange. A parked read rejects at once, any later write()
   * or read() throws, and the buffer is cleared so a reply already sitting in it
   * is not handed to the next driver.
   *
   * Revoking is idempotent and never touches the channel's OS resources: the
   * channel outlives the lease, because the next probe — or the printer that was
   * just detected — goes on using it.
   */
  revoke(reason) {
    if (this._controller.signal.aborted) return;
    this._controller.abort(new ProbeAbandonedError(
      `${this._label}: abandoned${reason ? ` — ${reason}` : ''}`));
    if (typeof this._channel.purgeInput === 'function') this._channel.purgeInput();
  }
}
