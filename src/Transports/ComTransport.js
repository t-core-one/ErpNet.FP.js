import { SerialPort } from 'serialport';
import { Transport } from '../Core/Transport.js';
import { ReceiveBuffer } from './ReceiveBuffer.js';
import { throwIfAbandoned } from '../Exceptions/ProbeAbandonedError.js';

const DEFAULT_BAUD_RATE = 115200;
const READ_TIMEOUT_MS = 500;

export class ComChannel {
  constructor(portPath, baudRate = DEFAULT_BAUD_RATE) {
    this._portPath = portPath;
    this._baudRate = baudRate;
    this._port = null;
    this._rx = new ReceiveBuffer(READ_TIMEOUT_MS);
    this._disposed = false;
  }

  get descriptor() {
    return this._portPath;
  }

  /**
   * Close for good. Detection races each driver against a timeout and moves on,
   * but an abandoned driver.connect() keeps retrying — and write() calls open(),
   * so it would re-open the port *after* cleanup and leak the lock forever (every
   * later probe then fails with "Cannot lock port", until the service restarts).
   * Once disposed the channel refuses to re-open, so stragglers die instead.
   *
   * Since leases arrived this is the blunt instrument of last resort: it kills a
   * channel nobody detected anything on. Revoking a lease is the per-probe tool,
   * and leaves the channel perfectly usable for the next driver.
   */
  async dispose() {
    this._disposed = true;
    await this.close();
  }

  async open() {
    if (this._disposed) throw new Error(`Channel for ${this._portPath} has been disposed`);
    if (this._port && this._port.isOpen) return;
    this._port = new SerialPort({
      path: this._portPath,
      baudRate: this._baudRate,
      autoOpen: false,
    });
    await new Promise((resolve, reject) => {
      this._port.open(err => err ? reject(err) : resolve());
    });
    // Attach unconditionally: we only get here having just constructed a BRAND
    // NEW SerialPort, so this runs exactly once per port object.
    //
    // This used to be guarded by a _listenerAttached flag that was cleared only
    // in close(). When the port closed ITSELF — USB re-enumeration, the printer
    // power-cycled, a serialport 'close'/'error' — no close() ran, the flag
    // stayed true, and the next open() built a new port with no accumulator on
    // it. Nothing ever reached the receive buffer again: every read() returned
    // empty, i.e. a silently dead channel that only a service restart fixed.
    // With no flag there is no state to go stale.
    this._port.on('data', data => this._rx.push(data));
  }

  async close() {
    // Release anybody parked on a read before the port goes away rather than
    // leaving them to their timeout, and drop bytes belonging to a port that no
    // longer exists.
    this._rx.reset();
    if (this._port && this._port.isOpen) {
      await new Promise((resolve) => this._port.close(resolve));
    }
  }

  /**
   * @param {Buffer} data
   * @param {AbortSignal} [signal] the caller's lease; an abandoned probe must
   *   not put another frame on the wire, so this is checked before open() too.
   */
  async write(data, signal) {
    throwIfAbandoned(signal);
    await this.open();
    throwIfAbandoned(signal);
    await new Promise((resolve, reject) => {
      this._port.write(data, err => err ? reject(err) : resolve());
    });
    await new Promise((resolve, reject) => {
      this._port.drain(err => err ? reject(err) : resolve());
    });
  }

  /**
   * Wait for the device's bytes. The queue lives in ReceiveBuffer: there is no
   * per-read 'data' listener any more, so two pending reads cannot take the
   * buffer from each other, and a revoked lease's read rejects at once instead
   * of quietly consuming somebody else's answer.
   */
  read(signal) {
    return this._rx.take(signal);
  }

  /** Drop buffered bytes — see ReceiveBuffer.purge for why, and who calls it. */
  purgeInput() {
    this._rx.purge();
  }
}

/**
 * Split "/dev/ttyUSB0?baud=9600" into its port path and baud rate. The suffix is
 * optional; anything unparseable falls back to the transport default. Serial
 * fiscal printers are not all 115200 — an FP-800 on an RS-232 link is commonly
 * 9600 — and a mismatched rate looks exactly like "no printer found".
 */
export function parsePortAddress(address, defaultBaudRate = DEFAULT_BAUD_RATE) {
  const [portPath, query = ''] = String(address).split('?');
  const m = /(?:^|&)baud(?:rate)?=(\d+)/i.exec(query);
  const baudRate = m ? parseInt(m[1], 10) : defaultBaudRate;
  return { portPath, baudRate: Number.isFinite(baudRate) && baudRate > 0 ? baudRate : defaultBaudRate };
}

export class ComTransport extends Transport {
  /** @param {number} [defaultBaudRate] service-wide default (appsettings BaudRate). */
  constructor(defaultBaudRate = DEFAULT_BAUD_RATE) {
    super();
    this._openedChannels = new Map();
    this._defaultBaudRate = Number(defaultBaudRate) > 0 ? Number(defaultBaudRate) : DEFAULT_BAUD_RATE;
  }

  get transportName() {
    return 'com';
  }

  _newChannel(address) {
    const { portPath, baudRate } = parsePortAddress(address, this._defaultBaudRate);
    return new ComChannel(portPath, baudRate);
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
    const channel = this._newChannel(address);
    this._openedChannels.set(address, channel);
    return channel;
  }

  createFreshChannel(address) {
    return this._newChannel(address);
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
    // Dispose, not just close: in-flight operations abandoned by a detection
    // timeout would otherwise re-open the port and leak the OS lock.
    if (typeof channel.dispose === 'function') {
      await channel.dispose();
    } else {
      await channel.close();
    }
  }
}
