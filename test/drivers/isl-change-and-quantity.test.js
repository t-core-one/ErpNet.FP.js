import { describe, it, expect } from 'vitest';
import { formatQuantity } from '../../src/Helpers/Helpers.js';
import { BgIslFiscalPrinter } from '../../src/Drivers/BgIslFiscalPrinter.js';
import { BgDatecsPIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsPIslFiscalPrinter.js';
import { PaymentType } from '../../src/Core/Payment.js';

// Both defects below were taken from the Mechka FP-800 debug log, where each
// produced `status=a98088ea869a` (E401 syntax error) followed by 0x3c — the
// receipt aborted after part of it had already printed.

describe('formatQuantity', () => {
  it('strips IEEE-754 noise that the device rejects', () => {
    // The logged line: {"Quantity": 1.1400000000000001} -> "*1.1400000000000001"
    expect(formatQuantity(1.1400000000000001)).toBe('1.14');
    expect(formatQuantity(0.1 + 0.2)).toBe('0.3');
  });

  it('keeps integers and real fractions intact', () => {
    expect(formatQuantity(1)).toBe('1');
    expect(formatQuantity(2.5)).toBe('2.5');
    expect(formatQuantity(0.35)).toBe('0.35');
  });

  it('caps at the 3 decimals these devices accept', () => {
    expect(formatQuantity(1.23456)).toBe('1.235');
  });

  it('handles missing or non-numeric input', () => {
    expect(formatQuantity(undefined)).toBe('0');
    expect(formatQuantity(null)).toBe('0');
  });
});

describe('BgDatecsPIslFiscalPrinter._addSale quantity on the wire', () => {
  it('sends 1.14, not 1.1400000000000001', async () => {
    const p = Object.create(BgDatecsPIslFiscalPrinter.prototype);
    p.info = { ItemTextMaxLength: 34 };
    p.getTaxGroupText = () => 'Б';
    let sent;
    p._sendCommand = async (_cmd, data) => { sent = data; };
    await p._addSale({ Text: 'СЕТ 750 мл', UnitPrice: 10.67, Quantity: 1.1400000000000001, TaxGroup: 2 });
    expect(sent).toBe('СЕТ 750 мл\tБ10.67*1.14');
  });
});

describe('BgIslFiscalPrinter._payableOnly', () => {
  const isl = Object.create(BgIslFiscalPrinter.prototype);

  // The reported production bug: PaymentType.Change has no entry in
  // paymentTypeMappings, so getPaymentTypeText fell back to '0' and the change
  // went out as "\t0-4.12" — a negative CASH payment the device refuses.
  it('drops the change line, which is not a payment on this protocol', () => {
    const payments = [
      { Amount: 10.3, PaymentType: PaymentType.Cash },
      { Amount: -4.12, PaymentType: PaymentType.Change },
    ];
    const payable = isl._payableOnly(payments);
    expect(payable).toHaveLength(1);
    expect(payable[0].Amount).toBe(10.3);
  });

  it('drops any negative amount, whatever its type', () => {
    expect(isl._payableOnly([{ Amount: -1, PaymentType: PaymentType.Cash }])).toHaveLength(0);
  });

  it('tolerates missing input', () => {
    expect(isl._payableOnly(null)).toEqual([]);
    expect(isl._payableOnly([])).toEqual([]);
  });
});

describe('BgIslFiscalPrinter._assertReceiptSettled with change', () => {
  const settle = async (deviceAmount, payments) => {
    const i = Object.create(BgIslFiscalPrinter.prototype);
    i._getReceiptAmount = async () => deviceAmount;
    try { await i._assertReceiptSettled(payments); return 'allowed'; }
    catch { return 'blocked'; }
  };

  it('allows over-tender, because that is exactly what change is', async () => {
    expect(await settle(6.18, [
      { Amount: 10.3, PaymentType: PaymentType.Cash },
      { Amount: -4.12, PaymentType: PaymentType.Change },
    ])).toBe('allowed');
  });

  it('still blocks a genuine shortfall', async () => {
    expect(await settle(6.18, [{ Amount: 6.17, PaymentType: PaymentType.Cash }])).toBe('blocked');
  });

  it('allows an exact payment', async () => {
    expect(await settle(6.18, [{ Amount: 6.18, PaymentType: PaymentType.Cash }])).toBe('allowed');
  });
});
