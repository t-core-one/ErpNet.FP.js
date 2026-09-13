import { describe, it, expect } from 'vitest';
import { ChannelLease } from '../../src/Core/ChannelLease.js';
import { ProbeAbandonedError } from '../../src/Exceptions/ProbeAbandonedError.js';
import { ReceiveBuffer } from '../../src/Transports/ReceiveBuffer.js';

/** A channel with the real receive semantics and a record of what was written. */
function fakeChannel(readTimeoutMs = 5000) {
  const rx = new ReceiveBuffer(readTimeoutMs);
  return {
    descriptor: '/dev/fake',
    writes: [],
    rx,
    async write(data, signal) {
      if (signal && signal.aborted) throw new ProbeAbandonedError('write after revoke');
      this.writes.push(data.toString());
    },
    read(signal) {
      return rx.take(signal);
    },
    purgeInput() {
      rx.purge();
    },
  };
}

describe('ChannelLease: a revocable handle, not a lock', () => {
  it('reads through to the channel descriptor, so driver cache keys are unchanged', () => {
    const lease = new ChannelLease(fakeChannel(), 'bg.dt.x.isl @ /dev/fake');
    expect(lease.descriptor).toBe('/dev/fake');
  });

  it('stops an abandoned probe from putting another frame on the wire', async () => {
    const channel = fakeChannel();
    const lease = new ChannelLease(channel, 'probe');

    await lease.write(Buffer.from('frame-1'));
    expect(channel.writes).toEqual(['frame-1']);

    lease.revoke('detection moved on');

    // The straggler's retry loop hits this and unwinds instead of transmitting
    // over the driver that is being tried next.
    await expect(lease.write(Buffer.from('frame-2'))).rejects.toThrow(ProbeAbandonedError);
    await expect(lease.read()).rejects.toThrow(ProbeAbandonedError);
    expect(channel.writes).toEqual(['frame-1']);
  });

  it('revoking never blocks and never waits for the straggler', () => {
    const lease = new ChannelLease(fakeChannel(), 'probe');
    const pending = lease.read(); // parked
    const started = Date.now();

    lease.revoke('detection moved on'); // synchronous

    expect(Date.now() - started).toBeLessThan(50);
    expect(lease.revoked).toBe(true);
    return expect(pending).rejects.toThrow(ProbeAbandonedError);
  });

  it('is idempotent', () => {
    const lease = new ChannelLease(fakeChannel(), 'probe');
    lease.revoke('first');
    expect(() => lease.revoke('second')).not.toThrow();
    expect(lease.revoked).toBe(true);
  });

  it('drops an abandoned exchange\'s late reply instead of feeding it to the next driver', async () => {
    const channel = fakeChannel();
    const lease = new ChannelLease(channel, 'probe');

    // The device answers after detection has already given up on this probe.
    channel.rx.push(Buffer.from('late answer to a dead probe'));
    lease.revoke('detection moved on');

    expect(channel.rx.length).toBe(0);
  });

  it('clears stale bytes before each command, since nothing correlates replies', async () => {
    const channel = fakeChannel();
    const lease = new ChannelLease(channel, 'probe');

    // Left over from a previous attempt; it cannot be the answer to what is
    // about to be sent, and ISL/ZFP never check the SEQ echo, so it would be
    // believed.
    channel.rx.push(Buffer.from('stale'));
    await lease.write(Buffer.from('fresh command'));

    expect(channel.rx.length).toBe(0);
  });

  it('leaves the channel usable for the next lease', async () => {
    const channel = fakeChannel();
    const abandoned = new ChannelLease(channel, 'probe-1');
    abandoned.revoke('detection moved on');

    // Revocation is per-probe: it must not close or poison the shared channel.
    const next = new ChannelLease(channel, 'probe-2');
    await next.write(Buffer.from('frame'));
    channel.rx.push(Buffer.from('reply'));
    expect((await next.read()).toString()).toBe('reply');
  });
});
