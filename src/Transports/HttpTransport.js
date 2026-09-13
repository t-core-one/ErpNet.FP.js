import { Transport } from '../Core/Transport.js';
import { throwIfAbandoned } from '../Exceptions/ProbeAbandonedError.js';

const REQUEST_TIMEOUT_MS = 60_000;

/** Stands in for "no lease" so the runtime path has an owner like everybody else. */
const NO_LEASE = Symbol('no lease');

/**
 * A single HTTP channel: one POST per command, response buffered for the following read.
 * HTTP is stateless so open/close are no-ops.
 *
 * The buffer is a one-slot mailbox, and it used to have no owner and no
 * take-and-clear: read() returned _lastResponse without emptying it, so a read
 * with no write in front of it silently returned the PREVIOUS command's answer,
 * and two overlapping exchanges each read whichever reply landed last. The SIS
 * driver's BUSY path sleeps between write and read, which is exactly the window
 * that lets another exchange win the slot. The slot now belongs to the lease
 * that filled it and is emptied when it is read.
 */
export class HttpChannel {
  constructor(url) {
    this._url = url;
    this._lastResponse = Buffer.alloc(0);
    this._responseOwner = null;
    this._hasResponse = false;
    this._disposed = false;
  }

  get descriptor() {
    return this._url;
  }

  /** @param {AbortSignal} [signal] the caller's lease — see ComChannel.write. */
  async write(data, signal) {
    throwIfAbandoned(signal);
    if (this._disposed) throw new Error(`Channel for ${this._url} has been disposed`);
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // A revoked lease aborts the POST in flight as well — for SIS that is the
    // only I/O there is, so without it "cancelled" would still mean waiting out
    // a 60s request.
    const onRevoke = () => controller.abort();
    if (signal) signal.addEventListener('abort', onRevoke, { once: true });
    try {
      const response = await fetch(this._url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      const arrayBuffer = await response.arrayBuffer();
      this._lastResponse = Buffer.from(arrayBuffer);
      this._responseOwner = signal || NO_LEASE;
      this._hasResponse = true;
    } catch (err) {
      this.purgeInput();
      throwIfAbandoned(signal);
      if (err.name === 'AbortError') {
        throw new Error(`Timeout while posting to ${this._url}`);
      }
      throw new Error(`HTTP error while posting to ${this._url}: ${err.message}`);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onRevoke);
    }
  }

  /**
   * Hand over the answer to THIS lease's last POST, once. Anything else — an
   * empty slot, or a reply that belongs to another exchange — reads as "nothing
   * yet", which is what every send path already knows how to handle.
   */
  async read(signal) {
    throwIfAbandoned(signal);
    const owner = signal || NO_LEASE;
    if (!this._hasResponse || this._responseOwner !== owner) {
      return Buffer.alloc(0);
    }
    const data = this._lastResponse;
    this.purgeInput();
    return data;
  }

  purgeInput() {
    this._lastResponse = Buffer.alloc(0);
    this._responseOwner = null;
    this._hasResponse = false;
  }

  async close() {
    // HTTP is stateless; nothing to close but the mailbox.
    this.purgeInput();
  }

  async dispose() {
    this._disposed = true;
    await this.close();
  }
}

/**
 * Generic HTTP transport. Manages a channel cache keyed by address.
 * getAvailableAddresses() returns [] — HTTP devices must be configured explicitly.
 */
export class HttpTransport extends Transport {
  constructor(defaultPath = '', contentType = 'application/json') {
    super();
    this._defaultPath = defaultPath;
    this._contentType = contentType;
    this._openedChannels = new Map();
  }

  get transportName() {
    return 'http';
  }

  async getAvailableAddresses() {
    return [];
  }

  _normalizeUrl(address) {
    let url = address;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`;
    }
    if (this._defaultPath) {
      const afterScheme = url.slice(url.indexOf('://') + 3);
      if (!afterScheme.includes('/')) {
        const path = this._defaultPath.startsWith('/') ? this._defaultPath : `/${this._defaultPath}`;
        url += path;
      }
    }
    return url;
  }

  openChannel(address) {
    if (this._openedChannels.has(address)) {
      return this._openedChannels.get(address);
    }
    const channel = new HttpChannel(this._normalizeUrl(address));
    this._openedChannels.set(address, channel);
    return channel;
  }

  createFreshChannel(address) {
    return new HttpChannel(this._normalizeUrl(address));
  }

  cacheChannel(address, channel) {
    this._openedChannels.set(address, channel);
  }

  async drop(channel) {
    for (const [key, ch] of this._openedChannels.entries()) {
      if (ch === channel) {
        this._openedChannels.delete(key);
        break;
      }
    }
    if (typeof channel.dispose === 'function') {
      await channel.dispose();
    } else {
      await channel.close();
    }
  }
}
