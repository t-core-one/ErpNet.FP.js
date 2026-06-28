import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BgDatecsPIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsPIslFiscalPrinter.js';
import { PriceModifierType, TaxGroup } from '../../src/Core/Item.js';
import { PaymentType } from '../../src/Core/Payment.js';

// CMD constants (from BgIslFiscalPrinter)
const CMD_FISCAL_RECEIPT_SALE  = 0x31;
const CMD_FISCAL_RECEIPT_TOTAL = 0x35;
const CMD_MONEY_TRANSFER       = 0x46;
const CMD_PRINT_DAILY_REPORT   = 0x45;
const CMD_OPEN_REVERSAL        = 0x2E;

const mockChannel = {
  write: async () => {},
  read: async () => Buffer.alloc(0),
  descriptor: 'test',
};

describe('BgDatecsPIslFiscalPrinter', () => {
  let printer;

  beforeEach(() => {
    printer = new BgDatecsPIslFiscalPrinter(mockChannel, null);
    vi.spyOn(printer, '_sendCommand').mockResolvedValue(Buffer.alloc(0));
  });

  // ── Open receipt ──────────────────────────────────────────────────────────

  describe('_formatOpenReceipt', () => {
    it('includes the operator, password, till=1 and USN', () => {
      const str = printer._formatOpenReceipt({
        Operator: '2', OperatorPassword: '1234', UniqueSaleNumber: 'BG123456-0001-0000001',
      });
      expect(str).toBe('2,1234,1,BG123456-0001-0000001');
    });

    it('uses defaults when operator/password are absent', () => {
      const str = printer._formatOpenReceipt({ UniqueSaleNumber: 'BG123456-0001-0000001' });
      expect(str).toBe('1,0000,1,BG123456-0001-0000001');
    });

    it('leaves USN empty when not provided', () => {
      const str = printer._formatOpenReceipt({ Operator: '1', OperatorPassword: '0000' });
      expect(str).toBe('1,0000,1,');
    });
  });

  // ── Reversal reason ───────────────────────────────────────────────────────

  describe('getReversalReasonText', () => {
    it('maps OperatorError (1) to E', () => expect(printer.getReversalReasonText(1)).toBe('E'));
    it('maps Refund (2) to R',         () => expect(printer.getReversalReasonText(2)).toBe('R'));
    it('maps TaxBaseReduction (3) to T',() => expect(printer.getReversalReasonText(3)).toBe('T'));
    it('defaults to E for unknown',    () => expect(printer.getReversalReasonText(99)).toBe('E'));
  });

  // ── Payment types ─────────────────────────────────────────────────────────

  describe('payment type mappings', () => {
    it('Cash is P',          () => expect(printer.getPaymentTypeText(PaymentType.Cash)).toBe('P'));
    it('Card is D',          () => expect(printer.getPaymentTypeText(PaymentType.Card)).toBe('D'));
    it('Check is C',         () => expect(printer.getPaymentTypeText(PaymentType.Check)).toBe('C'));
    it('Bank is r',          () => expect(printer.getPaymentTypeText(PaymentType.Bank)).toBe('r'));
    it('Coupons is m',       () => expect(printer.getPaymentTypeText(PaymentType.Coupons)).toBe('m'));
  });

  // ── _addSale ──────────────────────────────────────────────────────────────

  describe('_addSale', () => {
    const base = { TaxGroup: TaxGroup.TaxGroup1, UnitPrice: 1.50, Quantity: 0, PriceModifierType: PriceModifierType.None };

    it('sends FiscalReceiptSale command (0x31)', async () => {
      await printer._addSale({ ...base, Text: 'Beer' });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_FISCAL_RECEIPT_SALE);
    });

    it('basic sale: text TAB taxChar price', async () => {
      await printer._addSale({ ...base, Text: 'Beer' });
      const str = printer._sendCommand.mock.calls[0][1];
      expect(str).toMatch(/^Beer\t.+1\.50$/);
    });

    it('appends *qty when quantity is non-zero', async () => {
      await printer._addSale({ ...base, Text: 'Beer', Quantity: 2.5 });
      const str = printer._sendCommand.mock.calls[0][1];
      expect(str).toContain('*2.5');
    });

    it('omits quantity when zero', async () => {
      await printer._addSale({ ...base, Text: 'Beer', Quantity: 0 });
      const str = printer._sendCommand.mock.calls[0][1];
      expect(str).not.toContain('*');
    });

    it('discount percent: appends ,-pct', async () => {
      await printer._addSale({ ...base, Text: 'Beer', PriceModifierType: PriceModifierType.DiscountPercent, PriceModifierValue: 10 });
      expect(printer._sendCommand.mock.calls[0][1]).toContain(',-10.00');
    });

    it('surcharge percent: appends ,+pct', async () => {
      await printer._addSale({ ...base, Text: 'Beer', PriceModifierType: PriceModifierType.SurchargePercent, PriceModifierValue: 5 });
      expect(printer._sendCommand.mock.calls[0][1]).toContain(',5.00');
    });

    it('discount amount: appends ;-abs (P driver uses semicolon)', async () => {
      await printer._addSale({ ...base, Text: 'Beer', PriceModifierType: PriceModifierType.DiscountAmount, PriceModifierValue: 0.50 });
      expect(printer._sendCommand.mock.calls[0][1]).toContain(';-0.50');
    });

    it('surcharge amount: appends ;+abs', async () => {
      await printer._addSale({ ...base, Text: 'Beer', PriceModifierType: PriceModifierType.SurchargeAmount, PriceModifierValue: 0.25 });
      expect(printer._sendCommand.mock.calls[0][1]).toContain(';0.25');
    });

    it('truncates text to ItemTextMaxLength', async () => {
      const longText = 'A'.repeat(100);
      await printer._addSale({ ...base, Text: longText });
      const str = printer._sendCommand.mock.calls[0][1];
      const textPart = str.split('\t')[0];
      expect(textPart.length).toBe(printer.info.ItemTextMaxLength || 34);
    });
  });

  // ── _addPayment ───────────────────────────────────────────────────────────

  describe('_addPayment', () => {
    it('sends FiscalReceiptTotal command (0x35)', async () => {
      await printer._addPayment({ PaymentType: PaymentType.Cash, Amount: 10 });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_FISCAL_RECEIPT_TOTAL);
    });

    it('format: TAB + typeCode + amount for cash', async () => {
      await printer._addPayment({ PaymentType: PaymentType.Cash, Amount: 10 });
      expect(printer._sendCommand.mock.calls[0][1]).toBe('\tP10.00');
    });

    it('format: TAB + D + amount for card', async () => {
      await printer._addPayment({ PaymentType: PaymentType.Card, Amount: 25.50 });
      expect(printer._sendCommand.mock.calls[0][1]).toBe('\tD25.50');
    });
  });

  // ── Money transfer ────────────────────────────────────────────────────────

  describe('printMoneyDeposit', () => {
    it('sends MoneyTransfer (0x46) with positive amount', async () => {
      await printer.printMoneyDeposit({ Amount: 100 });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_MONEY_TRANSFER);
      expect(printer._sendCommand.mock.calls[0][1]).toBe('100.00');
    });
  });

  describe('printMoneyWithdraw', () => {
    it('sends MoneyTransfer (0x46) with negative amount', async () => {
      await printer.printMoneyWithdraw({ Amount: 50 });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_MONEY_TRANSFER);
      expect(printer._sendCommand.mock.calls[0][1]).toBe('-50.00');
    });
  });

  // ── Z / X reports ─────────────────────────────────────────────────────────

  describe('printZReport', () => {
    it('sends PrintDailyReport with retries=1 and timeout=90000', async () => {
      await printer.printZReport();
      const [cmd, data, retries, timeout] = printer._sendCommand.mock.calls[0];
      expect(cmd).toBe(CMD_PRINT_DAILY_REPORT);
      expect(data).toBeNull();
      expect(retries).toBe(1);
      expect(timeout).toBe(90000);
    });

    it('returns ok:true on success', async () => {
      const result = await printer.printZReport();
      expect(result.Ok).toBe(true);
    });

    it('returns ok:false when _sendCommand throws', async () => {
      printer._sendCommand.mockRejectedValueOnce(new Error('timeout'));
      const result = await printer.printZReport();
      expect(result.Ok).toBe(false);
    });
  });

  describe('printXReport', () => {
    it('sends PrintDailyReport with data="2"', async () => {
      await printer.printXReport();
      const [cmd, data] = printer._sendCommand.mock.calls[0];
      expect(cmd).toBe(CMD_PRINT_DAILY_REPORT);
      expect(data).toBe('2');
    });

    it('does not pass explicit retries (relies on _sendCommand default)', async () => {
      await printer.printXReport();
      const [, , retries] = printer._sendCommand.mock.calls[0];
      expect(retries).toBeUndefined();
    });
  });

  // ── Reversal receipt ──────────────────────────────────────────────────────

  describe('_openReversalReceipt', () => {
    it('sends CMD_OPEN_REVERSAL (0x2E)', async () => {
      await printer._openReversalReceipt({
        Operator: '1', OperatorPassword: '0000',
        UniqueSaleNumber: 'BG000000-0001-0000001',
        ReceiptNumber: '0100',
        FiscalMemorySerialNumber: 'FM12345678',
        Reason: 2, // Refund
        ReceiptDateTime: new Date(2024, 0, 15, 10, 30, 0),
      });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_OPEN_REVERSAL);
    });

    it('includes reason code in the header', async () => {
      await printer._openReversalReceipt({
        Operator: '1', OperatorPassword: '0000',
        ReceiptNumber: '0100',
        FiscalMemorySerialNumber: 'FM12345678',
        Reason: 2, // Refund → 'R'
        ReceiptDateTime: new Date(2024, 0, 15, 10, 30, 0),
      });
      const header = printer._sendCommand.mock.calls[0][1];
      expect(header).toContain('R0100'); // reason + receiptNum
    });
  });
});
