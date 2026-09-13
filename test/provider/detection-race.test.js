import { describe, it, expect } from 'vitest';
import { Provider } from '../../src/Provider/Provider.js';
import { Transport } from '../../src/Core/Transport.js';
import { ReceiveBuffer } from '../../src/Transports/ReceiveBuffer.js';

/**
 * The failure this reproduces, from a live shop:
 *
 * A Datecs FP-800 answered its serial port correctly and instantly, and the
 * service reported "Printers found: 0" over and over. The FP-800's driver is
 * THIRD in the list. Detection shares one channel across every driver probe and
 * races each against a 5s timeout without cancelling the loser, so the first two
 * probes were still parked in read() on that shared channel when the third
 * wrote its frame — and the device's answer went to a probe nobody was waiting
 * for any more.
 *
 * The channel below has the real receive semantics (ReceiveBuffer), so the only
 * thing under test is whether an abandoned probe is actually stopped.
 */

const READ_TIMEOUT_MS = 10_000; // long: a straggler parks and STAYS parked

class FakeChannel {
  constructor(address, device) {
    this.descriptor = address;
    this._device = device;
    this._rx = new ReceiveBuffer(READ_TIMEOUT_MS);
    this.writes = [];
    this.closed = false;
  }

  async write(data, signal) {
    if (signal && signal.aborted) {
      const err = new Error('write on a revoked lease');
      err.abandoned = true;
      throw err;
    }
    const frame = data.toString();
    this.writes.push(frame);
    // Half-duplex device: it answers only what it understands, and exactly once.
    const reply = this._device(frame);
    if (reply) setTimeout(() => this._rx.push(Buffer.from(reply)), 5);
  }

  read(signal) {
    return this._rx.take(signal);
  }

  purgeInput() {
    this._rx.purge();
  }

  async close() {
    this.closed = true;
    this._rx.reset();
  }

  async dispose() {
    await this.close();
  }
}

class FakeTransport extends Transport {
  constructor(device, address = '/dev/fake0') {
    super();
    this._device = device;
    this._address = address;
    this.channels = [];
    this.cached = new Map();
  }

  get transportName() { return 'com'; }
  async getAvailableAddresses() { return [this._address]; }

  createFreshChannel(address) {
    const channel = new FakeChannel(address, this._device);
    this.channels.push(channel);
    return channel;
  }

  openChannel(address) { return this.createFreshChannel(address); }
  cacheChannel(address, channel) { this.cached.set(address, channel); }
  async drop(channel) { await channel.dispose(); }
}

/** A probe that writes its frame and waits for an answer that never comes. */
function stragglerDriver(name) {
  return {
    driverName: name,
    finished: false,
    connect: async function (channel) {
      await channel.write(Buffer.from(`${name}?`));
      // Parks here for READ_TIMEOUT_MS unless somebody revokes the lease. This
      // is the straggler: detection gave up on it long ago.
      const answer = await channel.read();
      this.finished = true;
      if (!answer || answer.length === 0) throw new Error(`${name}: no answer`);
      return { info: { Manufacturer: 'Wrong', Model: name, SerialNumber: 'XX', Uri: null } };
    },
  };
}

/** The driver that is actually right for this device — third in the list. */
function realDriver(name) {
  return {
    driverName: name,
    connect: async function (channel) {
      await channel.write(Buffer.from(`${name}?`));
      const answer = await channel.read();
      if (!answer || answer.length === 0) throw new Error(`${name}: no answer`);
      return {
        info: {
          Manufacturer: 'Datecs', Model: 'FP-800',
          SerialNumber: 'DT123456', Uri: null,
        },
      };
    },
  };
}

describe('detection with two abandoned probes on the shared channel', () => {
  it('detects the device on the third driver', async () => {
    // The device answers only the third driver's frame — exactly the FP-800's
    // position in the real driver list.
    const transport = new FakeTransport(frame => (frame === 'bg.dt.p.isl?' ? 'DEVICE-INFO' : null));
    const provider = new Provider({ DetectionTimeout: '150ms', reconfigurePrinterConstants: () => {} });

    const stragglerA = stragglerDriver('bg.dt.x.isl');
    const stragglerB = stragglerDriver('bg.dt.c.isl');
    provider
      .register(stragglerA, transport)
      .register(stragglerB, transport)
      .register(realDriver('bg.dt.p.isl'), transport);

    const started = Date.now();
    const printers = await provider.detectAvailablePrinters();
    const elapsed = Date.now() - started;

    // Without revocation the two stragglers are still parked in read() when the
    // third driver writes, so the FIFO hands them the device's answer and this
    // is {}.
    expect(Object.keys(printers)).toEqual(['bg.dt.p.isl:///dev/fake0']);
    expect(printers['bg.dt.p.isl:///dev/fake0'].info.SerialNumber).toBe('DT123456');

    // Two abandoned probes at 150ms each, then a device that answers in 5ms.
    // If a straggler's 10s read were being waited out instead of revoked, this
    // would blow past it — the weaker "it eventually detects" assertion passed
    // against a build that took 1.6s to do it.
    expect(elapsed).toBeLessThan(1000);
  });

  it('stops an abandoned probe dead instead of letting it run on', async () => {
    const transport = new FakeTransport(frame => (frame === 'bg.dt.p.isl?' ? 'DEVICE-INFO' : null));
    const provider = new Provider({ DetectionTimeout: '150ms', reconfigurePrinterConstants: () => {} });

    const stragglerA = stragglerDriver('bg.dt.x.isl');
    const stragglerB = stragglerDriver('bg.dt.c.isl');
    provider
      .register(stragglerA, transport)
      .register(stragglerB, transport)
      .register(realDriver('bg.dt.p.isl'), transport);

    await provider.detectAvailablePrinters();

    // Both stragglers unwound at revocation rather than sitting on the channel a
    // live printer had just claimed for fiscal traffic.
    expect(stragglerA.finished).toBe(false);
    expect(stragglerB.finished).toBe(false);

    const channel = transport.channels[0];
    // Every frame on the wire, in order, one per driver: no straggler retried
    // over the top of the driver being tried next.
    expect(channel.writes).toEqual(['bg.dt.x.isl?', 'bg.dt.c.isl?', 'bg.dt.p.isl?']);
    // The detected printer keeps the channel — it is not dropped underneath it.
    expect(channel.closed).toBe(false);
    expect(transport.cached.get('/dev/fake0')).toBe(channel);
  });

  it('still drops the channel when nothing is detected', async () => {
    const transport = new FakeTransport(() => null);
    const provider = new Provider({ DetectionTimeout: '150ms', reconfigurePrinterConstants: () => {} });
    provider.register(stragglerDriver('bg.dt.x.isl'), transport);

    const printers = await provider.detectAvailablePrinters();

    expect(printers).toEqual({});
    expect(transport.channels[0].closed).toBe(true);
  });
});
