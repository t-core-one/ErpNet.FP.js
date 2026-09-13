import { abandonedError } from '../Exceptions/ProbeAbandonedError.js';

/**
 * The receive side of a stream channel: one accumulating buffer plus an ordered
 * queue of readers waiting on it.
 *
 * ComChannel and TcpChannel each used to implement this inline, and each had the
 * same defect. read() attached its OWN 'data' listener beside the accumulator,
 * and Node fires every listener on one event — so with two reads pending, each
 * listener independently did "take the buffer, clear the buffer" and the one
 * that had attached FIRST won the bytes while the caller anybody still cared
 * about resolved with an empty buffer.
 *
 * Two reads are pending routinely: detection shares one channel across every
 * driver probe and abandons each probe on a 5s race without cancelling it, so
 * the stragglers keep polling. That is how a Datecs FP-800 — third in the driver
 * list — reported "Printers found: 0" over and over while answering the port
 * correctly and instantly: the answer was handed to a probe nobody was waiting
 * for. It is the same mechanism that destroyed a Z report's reply when a
 * keep-alive landed inside it, before the job queue closed that hole.
 *
 * Here there is exactly one producer (push(), from the channel's single 'data'
 * listener) and one explicit FIFO of consumers, so nobody can take bytes out
 * from under anybody. A reader that carries an AbortSignal leaves the queue the
 * instant its lease is revoked, which is what makes cancellation real: the
 * straggler stops reading immediately instead of polling out its retry budget.
 */
export class ReceiveBuffer {
  /** @param {number} timeoutMs how long a reader waits for the first byte. */
  constructor(timeoutMs) {
    this._timeoutMs = timeoutMs;
    this._buffer = Buffer.alloc(0);
    this._waiters = [];
  }

  get length() {
    return this._buffer.length;
  }

  /** Readers parked on this buffer — one, in a healthy exchange. */
  get pendingReaders() {
    return this._waiters.length;
  }

  /** Feed bytes in. Called only from the channel's single 'data' listener. */
  push(data) {
    if (!data || data.length === 0) return;
    this._buffer = Buffer.concat([this._buffer, data]);
    this._serve();
  }

  /**
   * Take everything received, waiting up to timeoutMs for the first byte.
   *
   * Resolves with an empty buffer on timeout — the four driver send paths poll
   * in a loop and read empty as "nothing yet", so that contract is unchanged.
   * It REJECTS only when the caller's lease is revoked, which is the one case
   * where the caller must stop rather than poll again.
   */
  take(signal) {
    if (signal && signal.aborted) return Promise.reject(abandonedError(signal));
    if (this._buffer.length > 0) return Promise.resolve(this._drain());

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, timer: null, onAbort: null };
      waiter.timer = setTimeout(() => {
        this._settle(waiter);
        resolve(Buffer.alloc(0));
      }, this._timeoutMs);
      if (signal) {
        waiter.onAbort = () => {
          this._settle(waiter);
          reject(abandonedError(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this._waiters.push(waiter);
    });
  }

  /**
   * Drop whatever is buffered.
   *
   * Called before every command frame goes out, and when a lease is revoked. On
   * a half-duplex command/response link anything already in the buffer predates
   * the command about to be sent, so it cannot be its answer; and an abandoned
   * exchange's late reply must not be served to the next driver as if it were
   * its own. Nothing in these protocols correlates a response with its request —
   * ISL and ZFP both generate a SEQ byte and then never check the echo — so a
   * stolen frame is not merely noise, it is silently believed.
   */
  purge() {
    this._buffer = Buffer.alloc(0);
  }

  /** Shut down: drop the bytes and release every parked reader with an empty buffer. */
  reset() {
    this.purge();
    while (this._waiters.length > 0) {
      const waiter = this._waiters.shift();
      this._clear(waiter);
      waiter.resolve(Buffer.alloc(0));
    }
  }

  _drain() {
    const data = this._buffer;
    this._buffer = Buffer.alloc(0);
    return data;
  }

  _serve() {
    while (this._waiters.length > 0 && this._buffer.length > 0) {
      const waiter = this._waiters.shift();
      this._clear(waiter);
      waiter.resolve(this._drain());
    }
  }

  /** Take a waiter out of the queue and cancel its timer and abort hook. */
  _settle(waiter) {
    const idx = this._waiters.indexOf(waiter);
    if (idx >= 0) this._waiters.splice(idx, 1);
    this._clear(waiter);
  }

  _clear(waiter) {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }
}
