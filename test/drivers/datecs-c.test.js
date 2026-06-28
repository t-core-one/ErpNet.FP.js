import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BgDatecsCIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsCIslFiscalPrinter.js';
import { PriceModifierType, TaxGroup } from '../../src/Core/Item.js';
import { PaymentType } from '../../src/Core/Payment.js';
import { ReversalReason } from '../../src/Core/ReversalReceipt.js';

const CMD_FISCAL_RECEIPT_SALE  = 0x31;
const CMD_FISCAL_RECEIPT_TOTAL = 0x35;
const CMD_OPEN_REVERSAL        = 0x2E;

const mockChannel = {
  write: async () => {},
  read: async () => Buffer.alloc(0),
  descriptor: 'test',
};

describe('BgDatecsCIslFiscalPrinter', () => {
  let printer;

  beforeEach(() => {
    printer = new BgDatecsCIslFiscalPrinter(mockChannel, null);
    vi.spyOn(printer, '_sendCommand').mockResolvedValue(Buffer.alloc(0));
  });

  // ── Open receipt ──────────────────────────────────────────────────────────

  describe('_formatOpenReceipt', () => {
    it('formats without USN as op,pass,1', () => {
      expect(printer._formatOpenReceipt({ Operator: '1', OperatorPassword: '0000' }))
        .toBe('1,0000,1');
    });

    it('puts USN before the till number when present: op,pass,usn,1', () => {
      expect(printer._formatOpenReceipt({
        Operator: '1', OperatorPassword: '0000',
        UniqueSaleNumber: 'BG123456-0001-0000001',
      })).toBe('1,0000,BG123456-0001-0000001,1');
    });
  });

  // ── Reversal reason ───────────────────────────────────────────────────────

  describe('getReversalReasonText', () => {
    it('maps OperatorError to 0', () => expect(printer.getReversalReasonText(ReversalReason.OperatorError)).toBe('0'));
    it('maps Refund to 1',        () => expect(printer.getReversalReasonText(ReversalReason.Refund)).toBe('1'));
    it('maps TaxBaseReduction to 2',() => expect(printer.getReversalReasonText(ReversalReason.TaxBaseReduction)).toBe('2'));
  });

  // ── Payment types ─────────────────────────────────────────────────────────

  describe('payment type mappings', () => {
    it('Cash is P',    () => expect(printer.getPaymentTypeText(PaymentType.Cash)).toBe('P'));
    it('Card is C',    () => expect(printer.getPaymentTypeText(PaymentType.Card)).toBe('C'));
    it('Coupons is J', () => expect(printer.getPaymentTypeText(PaymentType.Coupons)).toBe('J'));
  });

  // ── _addSale ──────────────────────────────────────────────────────────────

  describe('_addSale', () => {
    const base = {
      TaxGroup: TaxGroup.TaxGroup1, UnitPrice: 2.00,
      Quantity: 0, PriceModifierType: PriceModifierType.None,
    };

    it('sends FiscalReceiptSale (0x31)', async () => {
      await printer._addSale({ ...base, Text: 'Item' });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_FISCAL_RECEIPT_SALE);
    });

    it('basic sale includes text, TAB, tax char, price', async () => {
      await printer._addSale({ ...base, Text: 'Item' });
      const str = printer._sendCommand.mock.calls[0][1];
      expect(str).toMatch(/^Item\t.+2\.00$/);
    });

    it('appends *qty when quantity set', async () => {
      await printer._addSale({ ...base, Text: 'Item', Quantity: 3 });
      expect(printer._sendCommand.mock.calls[0][1]).toContain('*3');
    });

    it('discount amount uses semicolon: ;-abs', async () => {
      await printer._addSale({
        ...base, Text: 'Item',
        PriceModifierType: PriceModifierType.DiscountAmount, PriceModifierValue: 1.00,
      });
      expect(printer._sendCommand.mock.calls[0][1]).toContain(';-1.00');
    });

    it('surcharge amount uses semicolon: ;+abs', async () => {
      await printer._addSale({
        ...base, Text: 'Item',
        PriceModifierType: PriceModifierType.SurchargeAmount, PriceModifierValue: 0.50,
      });
      expect(printer._sendCommand.mock.calls[0][1]).toContain(';0.50');
    });

    it('discount percent uses comma: ,-pct', async () => {
      await printer._addSale({
        ...base, Text: 'Item',
        PriceModifierType: PriceModifierType.DiscountPercent, PriceModifierValue: 10,
      });
      expect(printer._sendCommand.mock.calls[0][1]).toContain(',-10.00');
    });

    it('includes department when > 0', async () => {
      await printer._addSale({ ...base, Text: 'Item', Department: 2 });
      const str = printer._sendCommand.mock.calls[0][1];
      // department replaces the tax char: text\tdept\tprice
      expect(str).toContain('\t2\t');
    });
  });

  // ── _addPayment ───────────────────────────────────────────────────────────

  describe('_addPayment', () => {
    it('format: TAB + P + amount for cash', async () => {
      await printer._addPayment({ PaymentType: PaymentType.Cash, Amount: 15 });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_FISCAL_RECEIPT_TOTAL);
      expect(printer._sendCommand.mock.calls[0][1]).toBe('\tP15.00');
    });

    it('format: TAB + C + amount for card', async () => {
      await printer._addPayment({ PaymentType: PaymentType.Card, Amount: 9.99 });
      expect(printer._sendCommand.mock.calls[0][1]).toBe('\tC9.99');
    });
  });

  // ── Reversal receipt ──────────────────────────────────────────────────────

  describe('_openReversalReceipt', () => {
    it('sends CMD_OPEN_REVERSAL (0x2E)', async () => {
      await printer._openReversalReceipt({
        Operator: '1', OperatorPassword: '0000',
        ReceiptNumber: '0050', FiscalMemorySerialNumber: 'FM12345678',
        Reason: 1, ReceiptDateTime: new Date(2024, 2, 10, 9, 0, 0),
      });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_OPEN_REVERSAL);
    });

    it('puts USN before the till=1 field in the header', async () => {
      await printer._openReversalReceipt({
        Operator: '1', OperatorPassword: '0000',
        UniqueSaleNumber: 'BG000000-0001-0000001',
        ReceiptNumber: '0050', FiscalMemorySerialNumber: 'FM12345678',
        Reason: 1, ReceiptDateTime: new Date(2024, 2, 10, 9, 0, 0),
      });
      const header = printer._sendCommand.mock.calls[0][1];
      // format: op,pass,usn,1,reason,...
      expect(header).toMatch(/^1,0000,BG000000-0001-0000001,1,/);
    });
  });
});
