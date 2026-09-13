import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/** A SerialPort stand-in: opens, accepts writes, and can emit device bytes. */
class FakePort extends EventEmitter {
  constructor(opts) {
    super();
    this.path = opts.path;
    this.isOpen = false;
    this.written = [];
    FakePort.instances.push(this);
  }

  open(cb) { this.isOpen = true; cb(null); }
  write(data, cb) { this.written.push(data); cb(null); }
  drain(cb) { cb(null); }
  close(cb) { this.isOpen = false; cb(null); }

  /** The device answers. */
  deviceSends(text) { this.emit('data', Buffer.from(text)); }

  /** The port goes away on its own: USB re-enumeration, printer power-cycled. */
  diesOnItsOwn() { this.isOpen = false; this.emit('close'); }
}
FakePort.instances = [];

vi.mock('serialport', () => ({
  SerialPort: class { constructor(opts) { return new FakePort(opts); } },
}));

const { ComChannel } = await import('../../src/Transports/ComTransport.js');

describe('ComChannel keeps an accumulator on every port it opens', () => {
  beforeEach(() => { FakePort.instances = []; });

  it('receives what the device sends', async () => {
    const channel = new ComChannel('/dev/ttyUSB0', 115200);
    await channel.write(Buffer.from('cmd'));
    FakePort.instances[0].deviceSends('reply');
    expect((await channel.read()).toString()).toBe('reply');
  });

  it('still receives after the port closed ITSELF and was re-opened', async () => {
    // THE DEFECT: the 'data' listener was attached under a _listenerAttached
    // flag that was cleared only in close(). When the port died on its own —
    // USB re-enumeration, the printer power-cycled, a serialport 'close'/'error'
    // — no close() ran, the flag stayed set, and the next open() built a fresh
    // SerialPort with NO accumulator on it. Nothing reached the receive buffer
    // ever again: every read() returned empty, a silently dead channel that
    // only a service restart fixed.
    const channel = new ComChannel('/dev/ttyUSB0', 115200);
    await channel.write(Buffer.from('cmd-1'));
    expect(FakePort.instances).toHaveLength(1);

    FakePort.instances[0].diesOnItsOwn();

    await channel.write(Buffer.from('cmd-2')); // re-opens: a brand new port
    expect(FakePort.instances).toHaveLength(2);
    FakePort.instances[1].deviceSends('reply-after-reopen');

    expect((await channel.read()).toString()).toBe('reply-after-reopen');
  });

  it('still receives after an explicit close/re-open', async () => {
    const channel = new ComChannel('/dev/ttyUSB0', 115200);
    await channel.write(Buffer.from('cmd-1'));
    await channel.close();

    await channel.write(Buffer.from('cmd-2'));
    FakePort.instances[1].deviceSends('reply-after-close');

    expect((await channel.read()).toString()).toBe('reply-after-close');
  });

  it('attaches exactly one accumulator per port, so bytes are not doubled', async () => {
    const channel = new ComChannel('/dev/ttyUSB0', 115200);
    await channel.write(Buffer.from('cmd-1'));
    await channel.write(Buffer.from('cmd-2')); // open() returns early, no re-attach
    expect(FakePort.instances[0].listenerCount('data')).toBe(1);
  });

  it('releases a parked reader at once when the channel closes', async () => {
    const channel = new ComChannel('/dev/ttyUSB0', 115200);
    await channel.write(Buffer.from('cmd'));
    const pending = channel.read();
    const started = Date.now();

    await channel.close();

    expect((await pending).length).toBe(0);
    // Settled by close(), not left to expire on its own read timeout against a
    // port that no longer exists.
    expect(Date.now() - started).toBeLessThan(100);
  });
});
