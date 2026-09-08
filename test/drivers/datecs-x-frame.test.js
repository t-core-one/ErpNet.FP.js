import { describe, it, expect } from 'vitest';
import { BgDatecsXIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsXIslFiscalPrinter.js';
import { BgDatecsPIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsPIslFiscalPrinter.js';

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
