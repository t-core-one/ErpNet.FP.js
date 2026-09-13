import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.written = [];
    FakeSocket.instances.push(this);
  }

  connect(port, host, cb) { setImmediate(cb); return this; }
  write(data, cb) { this.written.push(data); cb(null); }
  destroy() { this.destroyed = true; }
  deviceSends(text) { this.emit('data', Buffer.from(text)); }
}
FakeSocket.instances = [];

vi.mock('net', () => ({
  default: { Socket: class { constructor() { return new FakeSocket(); } } },
}));

const { TcpChannel, TcpTransport } = await import('../../src/Transports/TcpTransport.js');

describe('TcpChannel', () => {
  beforeEach(() => { FakeSocket.instances = []; });

  it('receives what the device sends', async () => {
    const channel = new TcpChannel('10.0.0.5', 9100);
    await channel.write(Buffer.from('cmd'));
    FakeSocket.instances[0].deviceSends('reply');
    expect((await channel.read()).toString()).toBe('reply');
  });

  it('closing with a read parked settles it instead of crashing the service', async () => {
    // The old read() held a timer that fired a second later into
    // `this._socket.off(...)` — with _socket already null, because close() had
    // nulled it. An uncaught TypeError inside a timer callback takes the whole
    // process down, one second after a TCP channel is closed with a read
    // pending. ReceiveBuffer never touches the socket.
    const channel = new TcpChannel('10.0.0.5', 9100);
    await channel.write(Buffer.from('cmd'));
    const pending = channel.read();

    await channel.close();

    expect((await pending).length).toBe(0);
    // Nothing left armed to fire into a nulled socket.
    await new Promise(r => setTimeout(r, 50));
  });

  it('refuses to reconnect once disposed, so an abandoned probe cannot revive it', async () => {
    const channel = new TcpChannel('10.0.0.5', 9100);
    await channel.write(Buffer.from('cmd'));
    await channel.dispose();

    await expect(channel.write(Buffer.from('retry'))).rejects.toThrow(/disposed/i);
  });

  it('transport.drop() disposes rather than merely closing', async () => {
    const transport = new TcpTransport();
    const channel = transport.openChannel('10.0.0.5:9100');
    await transport.drop(channel);
    await expect(channel.connect()).rejects.toThrow(/disposed/i);
  });

  it('re-attaches an accumulator to a socket opened after a close', async () => {
    const channel = new TcpChannel('10.0.0.5', 9100);
    await channel.write(Buffer.from('cmd-1'));
    await channel.close();

    await channel.write(Buffer.from('cmd-2'));
    FakeSocket.instances[1].deviceSends('reply-after-close');

    expect((await channel.read()).toString()).toBe('reply-after-close');
  });
});
