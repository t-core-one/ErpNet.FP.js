import { describe, it, expect } from 'vitest';
import { ReceiveBuffer } from '../../src/Transports/ReceiveBuffer.js';
import { ProbeAbandonedError } from '../../src/Exceptions/ProbeAbandonedError.js';

describe('ReceiveBuffer: one producer, a FIFO of consumers', () => {
  it('gives a burst to the reader that asked first, and only to it', async () => {
    // THE BUG THIS REPLACES: each read() attached its own 'data' listener beside
    // the accumulator. Node fires every listener on one event, so both listeners
    // ran "take the buffer, clear the buffer" and the FIRST one attached won the
    // bytes while the caller anybody still cared about resolved empty.
    const rx = new ReceiveBuffer(200);
    const first = rx.take();
    const second = rx.take();
    expect(rx.pendingReaders).toBe(2);

    rx.push(Buffer.from('answer-1'));

    expect((await first).toString()).toBe('answer-1');
    // The loser waits for its own bytes rather than being handed an empty buffer.
    expect(rx.pendingReaders).toBe(1);
    rx.push(Buffer.from('answer-2'));
    expect((await second).toString()).toBe('answer-2');
  });

  it('serves bytes that arrived before the read was posted', async () => {
    const rx = new ReceiveBuffer(200);
    rx.push(Buffer.from('early'));
    expect((await rx.take()).toString()).toBe('early');
    // ...and take-and-clear: the same bytes are not served twice.
    expect(rx.length).toBe(0);
  });

  it('resolves empty on timeout, because every send path polls', async () => {
    const rx = new ReceiveBuffer(20);
    const data = await rx.take();
    expect(data.length).toBe(0);
    expect(rx.pendingReaders).toBe(0);
  });

  it('rejects a parked reader the moment its lease is revoked', async () => {
    const rx = new ReceiveBuffer(5000);
    const controller = new AbortController();
    const started = Date.now();
    const pending = rx.take(controller.signal);

    controller.abort(new ProbeAbandonedError('probe abandoned'));

    await expect(pending).rejects.toThrow(ProbeAbandonedError);
    // Immediately — not after the 5s read timeout. An abandoned probe that sits
    // out its read budget is still holding a queue slot, which is the whole
    // problem being fixed.
    expect(Date.now() - started).toBeLessThan(200);
    expect(rx.pendingReaders).toBe(0);
  });

  it('refuses a read posted after revocation without touching the device', async () => {
    const rx = new ReceiveBuffer(5000);
    const controller = new AbortController();
    controller.abort(new ProbeAbandonedError('already abandoned'));
    await expect(rx.take(controller.signal)).rejects.toThrow(ProbeAbandonedError);
  });

  it('leaves no bytes for the next exchange once purged', () => {
    const rx = new ReceiveBuffer(200);
    rx.push(Buffer.from('late reply from an abandoned probe'));
    rx.purge();
    expect(rx.length).toBe(0);
  });

  it('releases everyone parked when the channel closes', async () => {
    const rx = new ReceiveBuffer(5000);
    const a = rx.take();
    const b = rx.take();
    rx.reset();
    expect((await a).length).toBe(0);
    expect((await b).length).toBe(0);
    expect(rx.pendingReaders).toBe(0);
  });
});
