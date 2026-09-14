import { describe, it, expect, vi, beforeEach } from 'vitest';
import iconv from 'iconv-lite';
import { BgTremolZfpFiscalPrinter } from '../../src/Drivers/BgTremol/BgTremolZfpFiscalPrinter.js';
import { BgDatecsPIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsPIslFiscalPrinter.js';
import { ItemType, TaxGroup } from '../../src/Core/Item.js';
import { PaymentType } from '../../src/Core/Payment.js';
import { ReversalReason } from '../../src/Core/ReversalReceipt.js';

const channel = { write: async () => {}, read: async () => Buffer.alloc(0), descriptor: 'test' };
// Captured from an FP-28 with 0.02 turnover: field 0 is a flag, field 1 the cash.
const DAILY = '0;       0.02;       0.00;       0.00;       0.00;       0.00;       0.00;'
            + '       0.00;       0.00;       0.00;       0.00;       0.00;       0.00;';

describe('cash in drawer', () => {
  const withResponse = text => {
    const p = new BgTremolZfpFiscalPrinter(channel, null);
    vi.spyOn(p, '_sendCommand').mockResolvedValue(iconv.encode(text, 'cp1251'));
    return p;
  };

  it('reads the amount from field 1 of the semicolon-separated answer', async () => {
    const s = await withResponse(DAILY).cash();
    expect(s.Ok).toBe(true);
    // Splitting on ',' and taking field 0 read the leading flag, so this was 0.
    expect(s.Amount).toBe(0.02);
  });

  it('treats a value without a decimal point as stotinki', async () => {
    expect((await withResponse('0;2;0;0;').cash()).Amount).toBe(0.02);
  });

  it('reports a malformed answer instead of silently returning zero', async () => {
    const s = await withResponse('garbage').cash();
    expect(s.Ok).toBe(false);
    expect(s.Messages.map(m => m.Code)).toContain('E409');
  });
});

describe('Tremol reversal validation', () => {
  let printer;
  const base = () => ({
    UniqueSaleNumber: 'ZK212247-0015-0000002',
    Reason: ReversalReason.OperatorError,
    ReceiptNumber: '000019',
    ReceiptDateTime: new Date(2026, 8, 14, 11, 11, 41),
    FiscalMemorySerialNumber: '50273226',
    Items: [{ Type: ItemType.Sale, Text: 'Тест', TaxGroup: TaxGroup.TaxGroup2, UnitPrice: 0.01, Quantity: 1 }],
    Payments: [],
  });

  beforeEach(() => { printer = new BgTremolZfpFiscalPrinter(channel, null); });

  it('accepts a complete reversal', () => {
    expect(printer.validateReversalReceipt(base()).Ok).toBe(true);
  });

  it('rejects a reversal with no items — this is what printed as a 0.00 storno', () => {
    const s = printer.validateReversalReceipt({ ...base(), Items: [] });
    expect(s.Ok).toBe(false);
    expect(s.Messages.map(m => m.Code)).toContain('E210');
  });

  it('rejects a missing original receipt number or FM number', () => {
    expect(printer.validateReversalReceipt({ ...base(), ReceiptNumber: '' }).Ok).toBe(false);
    expect(printer.validateReversalReceipt({ ...base(), FiscalMemorySerialNumber: '' }).Ok).toBe(false);
  });

  it('keeps the payment line — the device needs it to close the storno', () => {
    // The reference implementation clears reversal payments, saying the device
    // ignores them. FP-28 firmware 1.04 does not: with no payment line the
    // storno has an unpaid balance and CloseReceipt (0x38) refuses it with
    // error 42, leaving a half-printed document on the paper. Observed on
    // ZK212244 against a working storno on ZK212247 that did send one.
    const rr = { ...base(), Payments: [{ PaymentType: PaymentType.Cash, Amount: 0.01 }] };
    const s = printer.validateReversalReceipt(rr);
    expect(s.Ok).toBe(true);
    expect(rr.Payments).toHaveLength(1);
    expect(s.Messages.map(m => m.Code)).not.toContain('W302');
  });

  it('leaves every other vendor on the shared validation', () => {
    // BgFiscalPrinter must stay untouched: an ISL printer keeps the base
    // behaviour, which does not check items on a reversal.
    const isl = new BgDatecsPIslFiscalPrinter(channel, null);
    expect(isl.validateReversalReceipt({ ...base(), Items: [] }).Ok).toBe(true);
  });
});
