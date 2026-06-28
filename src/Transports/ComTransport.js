import { SerialPort } from 'serialport';
import { Transport } from '../Core/Transport.js';

const DEFAULT_BAUD_RATE = 115200;
const READ_TIMEOUT_MS = 500;

export class ComChannel {
  constructor(portPath, baudRate = DEFAULT_BAUD_RATE) {
    this._portPath = portPath;
    this._baudRate = baudRate;
    this._port = null;
    this._buffer = Buffer.alloc(0);
    this._listenerAttached = false;
  }

  get descriptor() {
    return this._portPath;
  }

  async open() {
    if (this._port && this._port.isOpen) return;
    this._port = new SerialPort({
      path: this._portPath,
      baudRate: this._baudRate,
      autoOpen: false,
    });
    await new Promise((resolve, reject) => {
      this._port.open(err => err ? reject(err) : resolve());
    });
    if (!this._listenerAttached) {
      this._port.on('data', data => {
        this._buffer = Buffer.concat([this._buffer, data]);
      });
      this._listenerAttached = true;
    }
  }

  close() {
    if (this._port && this._port.isOpen) {
      return new Promise((resolve) => this._port.close(resolve));
    }
    return Promise.resolve();
  }

  async write(data) {
    await this.open();
    await new Promise((resolve, reject) => {
      this._port.write(data, err => err ? reject(err) : resolve());
    });
    await new Promise((resolve, reject) => {
      this._port.drain(err => err ? reject(err) : resolve());
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
        this._port.off('data', onData);
        resolve(Buffer.alloc(0));
      }, READ_TIMEOUT_MS);
      const onData = () => {
        clearTimeout(timer);
        this._port.off('data', onData);
        const data = this._buffer;
        this._buffer = Buffer.alloc(0);
        resolve(data);
      };
      this._port.once('data', onData);
    });
  }
}

export class ComTransport extends Transport {
  constructor() {
    super();
    this._openedChannels = new Map();
  }

  get transportName() {
    return 'com';
  }

  async getAvailableAddresses() {
    try {
      const ports = await SerialPort.list();
      return ports
        .filter(p => p.manufacturer || p.vendorId || p.serialNumber)
        .map(p => p.path);
    } catch (e) {
      return [];
    }
  }

  openChannel(address) {
    if (this._openedChannels.has(address)) {
      return this._openedChannels.get(address);
    }
    const channel = new ComChannel(address, DEFAULT_BAUD_RATE);
    this._openedChannels.set(address, channel);
    return channel;
  }

  createFreshChannel(address) {
    return new ComChannel(address, DEFAULT_BAUD_RATE);
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
