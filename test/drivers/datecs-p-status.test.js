import { describe, it, expect } from 'vitest';
import { BgDatecsPIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsPIslFiscalPrinter.js';
import { BgIslFiscalPrinter } from '../../src/Drivers/BgIslFiscalPrinter.js';

const p = Object.create(BgDatecsPIslFiscalPrinter.prototype);
const base = Object.create(BgIslFiscalPrinter.prototype);
const st = (...bytes) => Buffer.from(bytes);

// Observed on both live devices (Sofia FP-700, Mechka FP-800) while healthy.
const HEALTHY = [0x88, 0x80, 0x80, 0xea, 0x86, 0x9a];

describe('BgDatecsPIslFiscalPrinter.describeStatusErrors', () => {
  it('reports nothing for the healthy baseline of real hardware', () => {
    expect(p.describeStatusErrors(st(...HEALTHY))).toEqual([]);
  });

  it('reports nothing when only the frame markers are set', () => {
    expect(p.describeStatusErrors(st(0x80, 0x80, 0x80, 0x80, 0x80, 0x80))).toEqual([]);
  });

  // The regression this table exists for: closing a receipt that is not fully
  // paid sets E404. The base table watches 3 bits and missed it, so the driver
  // returned Ok, the POS booked the sale, and the receipt stayed open — which
  // corrupted both that receipt and the next one.
  it('detects E404 "not allowed in the current fiscal mode" (refused close)', () => {
    const errors = p.describeStatusErrors(st(0x80, 0x82, 0x80, 0xea, 0x86, 0x9a));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('E404');
  });

  it('the conservative base table still misses E404, which is why P overrides it', () => {
    expect(base.describeStatusErrors(st(0x80, 0x82, 0x80, 0xea, 0x86, 0x9a))).toEqual([]);
  });

  it.each([
    ['E199 general error',      [0xa0, 0x80, 0x80, 0xea, 0x86, 0x9a], 'E199'],
    ['E403 amount overflow',    [0x80, 0x81, 0x80, 0xea, 0x86, 0x9a], 'E403'],
    ['E301 no paper',           [0x80, 0x80, 0x81, 0xea, 0x86, 0x9a], 'E301'],
    ['E302 cover open',         [0xc0, 0x80, 0x80, 0xea, 0x86, 0x9a], 'E302'],
    ['E201 fiscal memory full', [0x80, 0x80, 0x80, 0xea, 0x90, 0x9a], 'E201'],
  ])('detects %s', (_label, bytes, code) => {
    const errors = p.describeStatusErrors(st(...bytes));
    expect(errors.join(' ')).toContain(code);
  });

  it('never treats byte 3 as a fault — it carries the DIP-switch state', () => {
    expect(p.describeStatusErrors(st(0x80, 0x80, 0x80, 0xff, 0x80, 0x80))).toEqual([]);
  });

  it('tolerates a short or empty status field', () => {
    expect(p.describeStatusErrors(st(0x80))).toEqual([]);
    expect(p.describeStatusErrors(Buffer.alloc(0))).toEqual([]);
  });
});

describe('BgIslFiscalPrinter._assertReceiptSettled', () => {
  const mk = (deviceAmount) => {
    const i = Object.create(BgIslFiscalPrinter.prototype);
    i._getReceiptAmount = async () => deviceAmount;
    return i;
  };
  const settle = async (deviceAmount, payments) => {
    try { await mk(deviceAmount)._assertReceiptSettled(payments); return 'allowed'; }
    catch { return 'blocked'; }
  };

  // The production failure: a discount made the device compute 4.64 while Odoo
  // paid 4.62, so the receipt could not be closed and was left open.
  it('blocks a close when the device total and the payments disagree', async () => {
    expect(await settle(4.64, [{ Amount: 4.62 }])).toBe('blocked');
    expect(await settle(4.62, [{ Amount: 4.64 }])).toBe('blocked');
  });

  it('allows an exact match, including split payments and change', async () => {
    expect(await settle(4.62, [{ Amount: 4.62 }])).toBe('allowed');
    expect(await settle(10, [{ Amount: 6 }, { Amount: 4 }])).toBe('allowed');
    expect(await settle(10, [{ Amount: 12 }, { Amount: -2 }])).toBe('allowed');
  });

  it('stays out of the way when there is nothing to compare', async () => {
    expect(await settle(4.64, [])).toBe('allowed');       // device pays itself
    expect(await settle(null, [{ Amount: 4.62 }])).toBe('allowed');
    expect(await settle(0, [{ Amount: 4.62 }])).toBe('allowed');
  });

  it('ignores sub-stotinka float noise', async () => {
    expect(await settle(10, [{ Amount: 9.999999 }])).toBe('allowed');
  });
});
