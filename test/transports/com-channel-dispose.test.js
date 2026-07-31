import { describe, it, expect, vi } from 'vitest';
import { ComChannel, ComTransport, parsePortAddress } from '../../src/Transports/ComTransport.js';

describe('ComChannel dispose (detection port-lock leak)', () => {
  it('refuses to re-open once disposed', async () => {
    const ch = new ComChannel('/dev/null-test', 9600);
    await ch.dispose();
    await expect(ch.open()).rejects.toThrow(/disposed/i);
  });

  it('write() cannot resurrect a disposed channel', async () => {
    // The actual leak: a driver.connect() abandoned by the detection timeout keeps
    // retrying, and write() calls open() — which used to re-open the port after
    // cleanup, holding the OS lock until the service restarted.
    const ch = new ComChannel('/dev/null-test', 9600);
    await ch.dispose();
    await expect(ch.write(Buffer.from([0x01]))).rejects.toThrow(/disposed/i);
  });

  it('transport.drop() disposes the channel and forgets it', async () => {
    const transport = new ComTransport();
    const ch = transport.openChannel('/dev/null-test');
    expect(transport.openChannel('/dev/null-test')).toBe(ch); // cached
    const disposeSpy = vi.spyOn(ch, 'dispose');

    await transport.drop(ch);

    expect(disposeSpy).toHaveBeenCalled();
    await expect(ch.open()).rejects.toThrow(/disposed/i);
    expect(transport.openChannel('/dev/null-test')).not.toBe(ch); // fresh one after drop
  });
});

describe('serial baud configuration', () => {
  it('defaults to 115200 and honours a per-URI override', () => {
    expect(parsePortAddress('/dev/ttyUSB0')).toEqual({ portPath: '/dev/ttyUSB0', baudRate: 115200 });
    expect(parsePortAddress('/dev/ttyUSB0?baud=9600').baudRate).toBe(9600);
    expect(parsePortAddress('/dev/ttyUSB0?baudrate=19200').baudRate).toBe(19200);
  });

  it('uses the transport default, and the URI beats it', () => {
    const transport = new ComTransport(9600);
    expect(transport.createFreshChannel('/dev/ttyUSB0')._baudRate).toBe(9600);
    expect(transport.createFreshChannel('/dev/ttyUSB0?baud=115200')._baudRate).toBe(115200);
  });

  it('keeps descriptor free of the query so driver cache keys are unchanged', () => {
    const ch = new ComTransport().createFreshChannel('/dev/ttyUSB0?baud=9600');
    expect(ch.descriptor).toBe('/dev/ttyUSB0');
  });

  it('falls back to the default on an unparseable rate', () => {
    expect(parsePortAddress('/dev/ttyUSB0?baud=nonsense').baudRate).toBe(115200);
    expect(parsePortAddress('/dev/ttyUSB0?baud=0', 9600).baudRate).toBe(9600);
  });
});
