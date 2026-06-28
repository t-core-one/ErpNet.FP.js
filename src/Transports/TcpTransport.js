import net from 'net';
import { Transport } from '../Core/Transport.js';

const DEFAULT_PORT = 9100;
const CONNECT_TIMEOUT_MS = 2000;
const READ_TIMEOUT_MS = 1000;

export class TcpChannel {
  constructor(hostName, port) {
    this._hostName = hostName;
    this._port = port;
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._listenerAttached = false;
  }

  get descriptor() {
    return `${this._hostName}:${this._port}`;
  }

  async connect() {
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
    if (!this._listenerAttached) {
      socket.on('data', data => {
        this._buffer = Buffer.concat([this._buffer, data]);
      });
      this._listenerAttached = true;
    }
    this._socket = socket;
  }

  close() {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._buffer = Buffer.alloc(0);
    this._listenerAttached = false;
    return Promise.resolve();
  }

  async write(data) {
    if (!this._socket || this._socket.destroyed) {
      await this.connect();
    }
    await new Promise((resolve, reject) => {
      this._socket.write(data, err => err ? reject(err) : resolve());
    });
  }

  async read() {
    if (this._buffer.length > 0) {
      const data = this._buffer;
      this._buffer = Buffer.alloc(0);
      return data;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._socket.off('data', onData);
        resolve(Buffer.alloc(0));
      }, READ_TIMEOUT_MS);
      const onData = () => {
        clearTimeout(timer);
        this._socket.off('data', onData);
        const data = this._buffer;
        this._buffer = Buffer.alloc(0);
        resolve(data);
      };
      this._socket.once('data', onData);
    });
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
    await channel.close();
  }
}
