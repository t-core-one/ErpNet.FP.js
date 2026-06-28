import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BgDatecsXIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsXIslFiscalPrinter.js';
import { PriceModifierType, TaxGroup } from '../../src/Core/Item.js';
import { PaymentType } from '../../src/Core/Payment.js';
import { ReversalReason } from '../../src/Core/ReversalReceipt.js';

const CMD_FISCAL_RECEIPT_SALE  = 0x31;
const CMD_FISCAL_RECEIPT_TOTAL = 0x35;
const CMD_MONEY_TRANSFER       = 0x46;
const CMD_PRINT_DAILY_REPORT   = 0x45;
const CMD_SET_DATETIME         = 0x3D;

const mockChannel = {
  write: async () => {},
  read: async () => Buffer.alloc(0),
  descriptor: 'test',
};

describe('BgDatecsXIslFiscalPrinter', () => {
  let printer;

  beforeEach(() => {
    printer = new BgDatecsXIslFiscalPrinter(mockChannel, null);
    vi.spyOn(printer, '_sendCommand').mockResolvedValue(Buffer.alloc(0));
  });

  // ── Open receipt ──────────────────────────────────────────────────────────

  describe('_formatOpenReceipt', () => {
    it('without USN: op TAB pass TAB 1 TAB TAB', () => {
      expect(printer._formatOpenReceipt({ Operator: '1', OperatorPassword: '0000' }))
        .toBe('1\t0000\t1\t\t');
    });

    it('with USN: op TAB pass TAB usn TAB 1 TAB TAB', () => {
      expect(printer._formatOpenReceipt({
        Operator: '1', OperatorPassword: '0000',
        UniqueSaleNumber: 'BG123456-0001-0000001',
      })).toBe('1\t0000\tBG123456-0001-0000001\t1\t\t');
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
    it('Cash is 0',  () => expect(printer.getPaymentTypeText(PaymentType.Cash)).toBe('0'));
    it('Card is 1',  () => expect(printer.getPaymentTypeText(PaymentType.Card)).toBe('1'));
    it('Check is 3', () => expect(printer.getPaymentTypeText(PaymentType.Check)).toBe('3'));
  });

  // ── _addSale ──────────────────────────────────────────────────────────────

  describe('_addSale', () => {
    const base = {
      TaxGroup: TaxGroup.TaxGroup1, UnitPrice: 3.00,
      Quantity: 0, PriceModifierType: PriceModifierType.None,
    };

    it('sends FiscalReceiptSale (0x31)', async () => {
      await printer._addSale({ ...base, Text: 'Item' });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_FISCAL_RECEIPT_SALE);
    });

    it('is fully tab-separated: text TAB tax TAB price TAB qty TAB modType TAB modVal TAB dept TAB', async () => {
      await printer._addSale({ ...base, Text: 'Item' });
      const str = printer._sendCommand.mock.calls[0][1];
      const parts = str.split('\t');
      expect(parts.length).toBe(8);
      expect(parts[0]).toBe('Item');
      expect(parts[2]).toBe('3.00');
    });

    it('qty field is empty when quantity is 0', async () => {
      await printer._addSale({ ...base, Text: 'Item', Quantity: 0 });
      const parts = printer._sendCommand.mock.calls[0][1].split('\t');
      expect(parts[3]).toBe('');
    });

    it('qty field is set when quantity is non-zero', async () => {
      await printer._addSale({ ...base, Text: 'Item', Quantity: 2 });
      const parts = printer._sendCommand.mock.calls[0][1].split('\t');
      expect(parts[3]).toBe('2');
    });

    it('modifier type code 0 when no modifier', async () => {
      await printer._addSale({ ...base, Text: 'Item' });
      const parts = printer._sendCommand.mock.calls[0][1].split('\t');
      expect(parts[4]).toBe('0'); // no modifier
    });

    it('modifier type code 2 for DiscountPercent', async () => {
      await printer._addSale({
        ...base, Text: 'Item',
        PriceModifierType: PriceModifierType.DiscountPercent, PriceModifierValue: 10,
      });
      const parts = printer._sendCommand.mock.calls[0][1].split('\t');
      expect(parts[4]).toBe('2');
      expect(parts[5]).toBe('10.00');
    });

    it('modifier type code 4 for DiscountAmount', async () => {
      await printer._addSale({
        ...base, Text: 'Item',
        PriceModifierType: PriceModifierType.DiscountAmount, PriceModifierValue: 0.50,
      });
      const parts = printer._sendCommand.mock.calls[0][1].split('\t');
      expect(parts[4]).toBe('4');
      expect(parts[5]).toBe('0.50');
    });

    it('modifier type code 1 for SurchargePercent', async () => {
      await printer._addSale({
        ...base, Text: 'Item',
        PriceModifierType: PriceModifierType.SurchargePercent, PriceModifierValue: 5,
      });
      const parts = printer._sendCommand.mock.calls[0][1].split('\t');
      expect(parts[4]).toBe('1');
    });

    it('modifier type code 3 for SurchargeAmount', async () => {
      await printer._addSale({
        ...base, Text: 'Item',
        PriceModifierType: PriceModifierType.SurchargeAmount, PriceModifierValue: 0.20,
      });
      const parts = printer._sendCommand.mock.calls[0][1].split('\t');
      expect(parts[4]).toBe('3');
    });
  });

  // ── _addPayment ───────────────────────────────────────────────────────────

  describe('_addPayment', () => {
    it('sends FiscalReceiptTotal (0x35)', async () => {
      await printer._addPayment({ PaymentType: PaymentType.Cash, Amount: 10 });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_FISCAL_RECEIPT_TOTAL);
    });

    it('format: typeCode TAB amount TAB terminalFlag TAB', async () => {
      await printer._addPayment({ PaymentType: PaymentType.Cash, Amount: 10 });
      const str = printer._sendCommand.mock.calls[0][1];
      expect(str).toBe('0\t10.00\t1\t');
    });

    it('terminal flag is 1 for non-card when UsePaymentTerminal is false', async () => {
      await printer._addPayment({ PaymentType: PaymentType.Cash, Amount: 5 });
      const parts = printer._sendCommand.mock.calls[0][1].split('\t');
      expect(parts[2]).toBe('1');
    });

    it('terminal flag is 2 for card when UsePaymentTerminal is true', async () => {
      printer.info.UsePaymentTerminal = true;
      await printer._addPayment({ PaymentType: PaymentType.Card, Amount: 20 });
      const parts = printer._sendCommand.mock.calls[0][1].split('\t');
      expect(parts[2]).toBe('2');
    });
  });

  // ── setDateTime ───────────────────────────────────────────────────────────

  describe('setDateTime', () => {
    it('sends SetDateTime (0x3D)', async () => {
      await printer.setDateTime({ DeviceDateTime: '2024-03-15T14:30:00' });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_SET_DATETIME);
    });

    it('formats as dd-MM-yy HH:mm:ss followed by a tab', async () => {
      await printer.setDateTime({ DeviceDateTime: '2024-03-15T14:30:00' });
      const str = printer._sendCommand.mock.calls[0][1];
      // Matches "15-03-24 14:30:00\t" (local-time interpretation)
      expect(str).toMatch(/^\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\t$/);
    });

    it('uses current time when datetime is null', async () => {
      await printer.setDateTime(null);
      const str = printer._sendCommand.mock.calls[0][1];
      expect(str).toMatch(/^\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\t$/);
    });

    it('returns ok:true on success', async () => {
      const status = await printer.setDateTime(null);
      expect(status.Ok).toBe(true);
    });
  });

  // ── Z / X reports ─────────────────────────────────────────────────────────

  describe('printZReport', () => {
    it('sends "Z\\t" with retries=1 and timeout=90000', async () => {
      await printer.printZReport();
      const [cmd, data, retries, timeout] = printer._sendCommand.mock.calls[0];
      expect(cmd).toBe(CMD_PRINT_DAILY_REPORT);
      expect(data).toBe('Z\t');
      expect(retries).toBe(1);
      expect(timeout).toBe(90000);
    });
  });

  describe('printXReport', () => {
    it('sends "X\\t" with retries=3 and timeout=30000', async () => {
      await printer.printXReport();
      const [cmd, data, retries, timeout] = printer._sendCommand.mock.calls[0];
      expect(cmd).toBe(CMD_PRINT_DAILY_REPORT);
      expect(data).toBe('X\t');
      expect(retries).toBe(3);
      expect(timeout).toBe(30000);
    });
  });

  // ── Money transfer ────────────────────────────────────────────────────────

  describe('printMoneyDeposit', () => {
    it('sends "0 TAB amount TAB" for deposit', async () => {
      await printer.printMoneyDeposit({ Amount: 200 });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_MONEY_TRANSFER);
      expect(printer._sendCommand.mock.calls[0][1]).toBe('0\t200.00\t');
    });
  });

  describe('printMoneyWithdraw', () => {
    it('sends "1 TAB amount TAB" for withdrawal', async () => {
      await printer.printMoneyWithdraw({ Amount: 75 });
      expect(printer._sendCommand.mock.calls[0][0]).toBe(CMD_MONEY_TRANSFER);
      expect(printer._sendCommand.mock.calls[0][1]).toBe('1\t75.00\t');
    });
  });
});
