import net from 'net';
import { Transport } from '../Core/Transport.js';
import { ReceiveBuffer } from './ReceiveBuffer.js';
import { throwIfAbandoned } from '../Exceptions/ProbeAbandonedError.js';

const DEFAULT_PORT = 9100;
const CONNECT_TIMEOUT_MS = 2000;
const READ_TIMEOUT_MS = 1000;

export class TcpChannel {
  constructor(hostName, port) {
    this._hostName = hostName;
    this._port = port;
    this._socket = null;
    this._rx = new ReceiveBuffer(READ_TIMEOUT_MS);
    this._disposed = false;
  }

  get descriptor() {
    return `${this._hostName}:${this._port}`;
  }

  /**
   * Close for good — the TCP twin of ComChannel.dispose(), and it was missing.
   * drop() only destroyed the socket, and write() reconnects whenever the socket
   * is gone, so an abandoned probe's next retry re-established the connection
   * detection had just torn down. Once disposed the channel refuses to connect.
   */
  async dispose() {
    this._disposed = true;
    await this.close();
  }

  async connect() {
    if (this._disposed) throw new Error(`Channel for ${this.descriptor} has been disposed`);
    if (this._socket && !this._socket.destroyed) return;
    const socket = new net.Socket();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timeout connecting to ${this._hostName}:${this._port}`));
      }, CONNECT_TIMEOUT_MS);
      socket.connect(this._port, this._hostName, () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
    // Attach unconditionally — a brand new socket every time, so exactly once
    // per socket. See ComChannel.open() for what the old guard flag cost.
    socket.on('data', data => this._rx.push(data));
    this._socket = socket;
  }

  async close() {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    // Settle parked readers here. They used to hold a timer that fired a second
    // later into `this._socket.off(...)` with _socket already null — an uncaught
    // TypeError inside a timer callback, i.e. the whole service down one second
    // after a TCP channel was closed with a read pending. ReceiveBuffer never
    // touches the socket, and reset() releases the readers now rather than later.
    this._rx.reset();
  }

  /** @param {AbortSignal} [signal] the caller's lease — see ComChannel.write. */
  async write(data, signal) {
    throwIfAbandoned(signal);
    if (!this._socket || this._socket.destroyed) {
      await this.connect();
    }
    throwIfAbandoned(signal);
    await new Promise((resolve, reject) => {
      this._socket.write(data, err => err ? reject(err) : resolve());
    });
  }

  read(signal) {
    return this._rx.take(signal);
  }

  /** Drop buffered bytes — see ReceiveBuffer.purge for why, and who calls it. */
  purgeInput() {
    this._rx.purge();
  }
}

export class TcpTransport extends Transport {
  constructor() {
    super();
    this._openedChannels = new Map();
  }

  get transportName() {
    return 'tcp';
  }

  getAvailableAddresses() {
    return [];
  }

  _parseAddress(address) {
    const parts = address.split(':');
    if (parts.length === 1) return [address, DEFAULT_PORT];
    return [parts[0], parseInt(parts[1], 10) || DEFAULT_PORT];
  }

  openChannel(address) {
    if (this._openedChannels.has(address)) {
      return this._openedChannels.get(address);
    }
    const [host, port] = this._parseAddress(address);
    const channel = new TcpChannel(host, port);
    this._openedChannels.set(address, channel);
    return channel;
  }

  createFreshChannel(address) {
    const [host, port] = this._parseAddress(address);
    return new TcpChannel(host, port);
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
    // Dispose, not just close, for the same reason as ComTransport: a straggler
    // whose write() silently reconnects is a channel back from the dead.
    if (typeof channel.dispose === 'function') {
      await channel.dispose();
    } else {
      await channel.close();
    }
  }
}
