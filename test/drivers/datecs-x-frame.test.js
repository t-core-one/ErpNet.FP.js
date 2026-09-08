import { describe, it, expect, vi, afterEach } from 'vitest';
import { BgDatecsXIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsXIslFiscalPrinter.js';
import { BgDatecsPIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsPIslFiscalPrinter.js';
import { BgIslFiscalPrinter } from '../../src/Drivers/BgIslFiscalPrinter.js';

/**
 * The Datecs X series speaks a different frame from the rest of the ISL family.
 *
 * This port shipped without upstream's BgDatecsXIslFiscalPrinter.Frame.cs, so
 * the X driver inherited the one-byte-header frame and sent it to X hardware. A
 * fiscalized FP-700X answered SYN then NAK to every command — a format/checksum
 * complaint — so every driver timed out and the device was reported as simply
 * not detected, indistinguishable from an unplugged printer.
 *
 * The expected bytes below are not derived from the implementation: they are the
 * exact frame a live FP-700X (firmware 3.00 22Jul25) accepted and answered,
 * captured on the wire.
 */
const mk = (Cls) => new Cls({}, {}, {});

describe('Datecs X frame', () => {
  it('builds the frame a live FP-700X accepted', () => {
    const frame = mk(BgDatecsXIslFiscalPrinter)
      ._buildHostFrame(0x21, 0x5a, Buffer.from('1', 'latin1'));
    expect(frame.toString('hex')).toBe('013030323b213030353a310530313f3303');
  });

  it('widens LEN and CMD to four bytes each', () => {
    const frame = mk(BgDatecsXIslFiscalPrinter)._buildHostFrame(0x21, 0x5a, Buffer.from('1', 'latin1'));
    expect(frame[0]).toBe(0x01);                                   // preamble
    expect([...frame.slice(1, 5)]).toEqual([0x30, 0x30, 0x32, 0x3b]); // LEN = 0x20+10+1 = 0x2B
    expect(frame[5]).toBe(0x21);                                   // SEQ, still one byte
    expect([...frame.slice(6, 10)]).toEqual([0x30, 0x30, 0x35, 0x3a]); // CMD 0x5A
    expect(frame[frame.length - 1]).toBe(0x03);                    // terminator
  });

  it('encodes nibbles as nibble+0x30, not ASCII hex', () => {
    // 0xB must be 0x3B (";"), never 0x42 ("B") — the two agree only for 0-9,
    // which is why a wrong encoding can look fine on some commands.
    const frame = mk(BgDatecsXIslFiscalPrinter)._buildHostFrame(0x21, 0x5a, Buffer.from('1', 'latin1'));
    expect(frame[4]).toBe(0x3b);
    expect(frame[4]).not.toBe(0x42);
  });

  it('checksums every byte after the preamble through the postamble', () => {
    const frame = mk(BgDatecsXIslFiscalPrinter)._buildHostFrame(0x21, 0x5a, Buffer.from('1', 'latin1'));
    const post = frame.lastIndexOf(0x05);
    let sum = 0;
    for (const b of frame.slice(1, post + 1)) sum += b;
    const bcc = frame.slice(post + 1, post + 5);
    expect(sum).toBe(499);
    expect([...bcc]).toEqual([0x30, 0x31, 0x3f, 0x33]);
  });

  it('does not disturb the P driver, whose frame is known good on an FP-700', () => {
    const frame = mk(BgDatecsPIslFiscalPrinter)._buildHostFrame(0x21, 0x5a, Buffer.from('1', 'latin1'));
    expect(frame.toString('hex')).toBe('0125215a310530303d3603');
  });

  it('reads the payload past the wider header', () => {
    expect(mk(BgDatecsXIslFiscalPrinter).responseHeaderLength).toBe(10);
    expect(mk(BgDatecsPIslFiscalPrinter).responseHeaderLength).toBe(4);
  });
});

describe('Datecs X status decoding', () => {
  // Captured from the live FP-700X: fiscalized, FM formatted, VAT set, tax
  // number set, serial+FM set. All informational — none may surface as an error
  // or every single command would be reported as rejected.
  const HEALTHY = Buffer.from('80808080869a8080', 'hex');

  it('reports no error for a healthy fiscalized device', () => {
    expect(mk(BgDatecsXIslFiscalPrinter).describeStatusErrors(HEALTHY)).toEqual([]);
  });

  it('catches the failures that must never be missed', () => {
    const d = mk(BgDatecsXIslFiscalPrinter);
    const withBit = (byteIdx, bit) => {
      const b = Buffer.from(HEALTHY);
      b[byteIdx] |= (1 << bit);
      return d.describeStatusErrors(b);
    };
    expect(withBit(2, 0)).toContain('E301 End of paper');       // paper out
    expect(withBit(1, 1)).toContain('E404 Command is not permitted');
    expect(withBit(0, 5)).toContain('E199 General error');
    expect(withBit(0, 6)).toContain('E302 Cover is open');
  });

  it('does not report warnings or info as errors', () => {
    const d = mk(BgDatecsXIslFiscalPrinter);
    const b = Buffer.from(HEALTHY);
    b[2] |= (1 << 1);   // W301 near paper end — a warning
    b[2] |= (1 << 3);   // "Fiscal receipt is open" — informational
    expect(d.describeStatusErrors(b)).toEqual([]);
  });

  it('does not inherit the P table, which would invent errors on X hardware', () => {
    // Byte 1 bit 2 is "The RAM has been reset" on the P series and reserved on
    // the X series. Decoding an X reply with the P table therefore reports a
    // fault the device never raised — the two tables are not interchangeable,
    // and the overlap on other bits makes that easy to miss.
    const bytes = Buffer.from(HEALTHY);
    bytes[1] |= (1 << 2);
    expect(mk(BgDatecsXIslFiscalPrinter).describeStatusErrors(bytes)).toEqual([]);
    expect(mk(BgDatecsPIslFiscalPrinter).describeStatusErrors(bytes))
      .toContain('E104 The RAM has been reset');
  });
});

/**
 * Command results on the X family arrive in the response DATA, not the status
 * bytes. Field 0 is a result code: "0" for success, a negative number for a
 * rejection. The base driver reads only the status bytes, so on a live FP-700X
 * every sale line was refused with -111005 while the printer reported itself
 * perfectly healthy — the receipt opened, took no items, and could not close.
 * The paper showed a receipt that started and never finished, and the POS was
 * told the sale had worked.
 */
describe('Datecs X result codes', () => {
  // The X override calls super._sendCommand, so the base has to be stubbed —
  // but via a spy that is restored, never by assigning to the shared prototype,
  // which would leak into every other test in the run.
  afterEach(() => vi.restoreAllMocks());

  const withResponse = (text) => {
    vi.spyOn(BgIslFiscalPrinter.prototype, '_sendCommand')
      .mockResolvedValue(Buffer.from(text, 'latin1'));
    return new BgDatecsXIslFiscalPrinter({}, {}, {});
  };

  it('rejects a command whose result code is negative', async () => {
    await expect(withResponse('-111005\t')._sendCommand(0x31, null))
      .rejects.toThrow(/rejected command 0x31 with error code -111005/);
  });

  it('accepts a success code', async () => {
    const resp = await withResponse('0\t9754\t')._sendCommand(0x38, null);
    expect(resp.toString('latin1')).toBe('0\t9754\t');
  });

  it('does not mistake a device-info reply for an error', async () => {
    // GetDeviceInfo answers with no result code at all; a blanket check here
    // would make the device undetectable all over again.
    const info = 'FP-700X,3.00 22Jul25 0922,2209,00000000,DT652532,79012510';
    const resp = await withResponse(info)._sendCommand(0x5a, '1');
    expect(resp.toString('latin1')).toBe(info);
  });
});

describe('Datecs X tax groups', () => {
  it('uses digits, not the Cyrillic letters the rest of the family uses', () => {
    const x = new BgDatecsXIslFiscalPrinter({}, {}, {});
    const p = new BgDatecsPIslFiscalPrinter({}, {}, {});
    expect(x.getTaxGroupText(2)).toBe('2');
    expect(p.getTaxGroupText(2)).toBe('Б');
  });
});

describe('Datecs X receipt amount', () => {
  const withResponse = (text) => {
    const p = new BgDatecsXIslFiscalPrinter({}, {}, {});
    p._sendCommand = async () => Buffer.from(text, 'latin1');
    return p;
  };

  it('reads the total from the tab-separated reply', async () => {
    // Captured live: code, isOpen, docNumber, items, total, paid.
    expect(await withResponse('0\t1\t9754\t1\t0.01\t0.01\t')._getReceiptAmount()).toBe(0.01);
  });

  it('would have returned 0 under the base comma parser, disabling the guard', async () => {
    // The settlement check skips when the amount is 0, so a wrong parse does not
    // fail loudly — it silently removes the protection.
    const p = new BgDatecsPIslFiscalPrinter({}, {}, {});
    p._sendCommand = async () => Buffer.from('0\t1\t9754\t1\t0.01\t0.01\t', 'latin1');
    expect(await p._getReceiptAmount()).toBe(0);
  });
});

/**
 * A reversal's reference date crosses the wire as JSON, which has no Date type,
 * so it arrives as an ISO string. The X driver formatted it with date methods
 * directly and threw "dt.getFullYear is not a function", failing the storno
 * before a single byte reached the device.
 */
describe('Datecs X storno reference date', () => {
  const open = (receiptDateTime) => new BgDatecsXIslFiscalPrinter({}, {}, {})
    ._formatOpenReversalReceipt({
      UniqueSaleNumber: 'DT652532-0053-0000009',
      ReceiptNumber: '9765',
      FiscalMemorySerialNumber: '79012510',
      ReceiptDateTime: receiptDateTime,
    });

  it('accepts the ISO string the POS actually sends', () => {
    // Exactly what Odoo stores in fd_receipt_date.
    expect(open('2026-09-08T14:36:16.000Z')).toContain('-09-26 ');
    expect(open('2026-09-08T14:36:16.000Z')).not.toMatch(/NaN/);
  });

  it('still accepts a real Date', () => {
    expect(open(new Date(2026, 8, 8, 17, 36, 16))).toContain('08-09-26 17:36:16');
  });

  it('never emits NaN into a fiscal field for an unparseable date', () => {
    for (const bad of ['not a date', '', null, undefined, {}]) {
      expect(open(bad)).not.toMatch(/NaN/);
    }
  });
});
