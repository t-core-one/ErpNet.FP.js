import { Transport } from '../Core/Transport.js';

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * A single HTTP channel: one POST per command, response buffered for the following read.
 * HTTP is stateless so open/close are no-ops.
 */
export class HttpChannel {
  constructor(url) {
    this._url = url;
    this._lastResponse = Buffer.alloc(0);
  }

  get descriptor() {
    return this._url;
  }

  async write(data) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(this._url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      const arrayBuffer = await response.arrayBuffer();
      this._lastResponse = Buffer.from(arrayBuffer);
    } catch (err) {
      this._lastResponse = Buffer.alloc(0);
      if (err.name === 'AbortError') {
        throw new Error(`Timeout while posting to ${this._url}`);
      }
      throw new Error(`HTTP error while posting to ${this._url}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async read() {
    return this._lastResponse;
  }

  async close() {
    // HTTP is stateless; nothing to close.
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
    await channel.close();
  }
}
