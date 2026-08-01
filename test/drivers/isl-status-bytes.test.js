import { describe, it, expect } from 'vitest';
import { describeStatusErrors } from '../../src/Drivers/BgIslFiscalPrinter.js';

const st = (...bytes) => Buffer.from(bytes);

describe('ISL status-byte error detection', () => {
  it('treats a real healthy FP-800 status as OK', () => {
    // Measured on Datecs FP-800 fw 7.00BG 23FEB26 1030 while printing fine.
    // Bytes 3-5 carry many informational bits — a naive "any bit set is an
    // error" rule would fail every operation on healthy hardware.
    expect(describeStatusErrors(st(0x88, 0x80, 0x80, 0xea, 0x86, 0x9a))).toEqual([]);
  });

  it('ignores "no external display" (byte 0 bit 3)', () => {
    expect(describeStatusErrors(st(0x88, 0x80, 0x80, 0x80, 0x80, 0x80))).toEqual([]);
  });

  it('all-clear status yields no errors', () => {
    expect(describeStatusErrors(st(0x80, 0x80, 0x80, 0x80, 0x80, 0x80))).toEqual([]);
  });

  it('detects a syntax error (byte 0 bit 0)', () => {
    expect(describeStatusErrors(st(0x81, 0x80, 0x80, 0x80, 0x80, 0x80)))
      .toContain('syntax error in the command');
  });

  it('detects an invalid/rejected command (byte 0 bit 1)', () => {
    expect(describeStatusErrors(st(0x82, 0x80, 0x80, 0x80, 0x80, 0x80)))
      .toContain('command rejected as invalid by the device');
  });

  it('detects out of paper (byte 2 bit 0)', () => {
    expect(describeStatusErrors(st(0x80, 0x80, 0x81, 0x80, 0x80, 0x80)))
      .toContain('out of paper');
  });

  it('reports several conditions at once', () => {
    expect(describeStatusErrors(st(0x83, 0x80, 0x81, 0x80, 0x80, 0x80))).toHaveLength(3);
  });

  it('tolerates a short or empty status field', () => {
    expect(describeStatusErrors(Buffer.alloc(0))).toEqual([]);
    expect(describeStatusErrors(st(0x80))).toEqual([]);
  });
});
