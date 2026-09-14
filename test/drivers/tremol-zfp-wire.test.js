import { describe, it, expect, vi, beforeEach } from 'vitest';
import iconv from 'iconv-lite';
import { BgTremolZfpFiscalPrinter } from '../../src/Drivers/BgTremol/BgTremolZfpFiscalPrinter.js';
import { CMD } from '../../src/Drivers/BgZfp/BgZfpFiscalPrinter.js';
import { ItemType, PriceModifierType, TaxGroup } from '../../src/Core/Item.js';
import { PaymentType } from '../../src/Core/Payment.js';
import { ReversalReason } from '../../src/Core/ReversalReceipt.js';

// The ZFP wire format, pinned to what a Tremol device actually accepts.
//
// These exact payloads were sent to an FP-28 (ZK212247) and answered ACK "00";
// the previous tab-separated form got no answer at all. The protocol layouts
// come from the reference C# implementation, whose BgZfpFiscalPrinter is the
// shared base for Tremol V1 and V2 exactly as this one is.
const USN = 'ZK212247-0015-0000002';
const channel = { write: async () => {}, read: async () => Buffer.alloc(0), descriptor: 'test' };

describe('Tremol ZFP wire format', () => {
  let printer, sent;

  beforeEach(() => {
    printer = new BgTremolZfpFiscalPrinter(channel, null);
    sent = [];
    vi.spyOn(printer, '_sendCommand').mockImplementation(async (cmd, data) => {
      sent.push({ cmd, text: data ? iconv.decode(data, 'cp1251') : null, raw: data });
      return Buffer.alloc(0);
    });
  });

  const only = () => { expect(sent).toHaveLength(1); return sent[0]; };

  it('opens a sale with five semicolon fields and $ before the УНП', async () => {
    await printer._openReceipt({ Operator: '1', OperatorPassword: '0000', UniqueSaleNumber: USN });
    const { cmd, text } = only();
    expect(cmd).toBe(CMD.OpenReceipt);
    expect(text).toBe(`1;0000;1;1;2$${USN}`);
  });

  it('defaults the operator and password when the caller omits them', async () => {
    await printer._openReceipt({ UniqueSaleNumber: USN });
    expect(only().text).toBe(`1;0000;1;1;2$${USN}`);
  });

  it('opens a reversal with the reason, original receipt and FM number', async () => {
    await printer._openReceipt(
      { Operator: '1', OperatorPassword: '0000', UniqueSaleNumber: USN }, true,
      {
        Reason: ReversalReason.OperatorError,
        ReceiptNumber: '000123',
        ReceiptDateTime: new Date(2026, 8, 11, 15, 2, 37),
        FiscalMemorySerialNumber: '50273226',
      });
    const { cmd, text } = only();
    expect(cmd).toBe(CMD.OpenReceipt);
    expect(text).toBe(
      `1;0000;1;1;D;${printer.getReversalReasonText(ReversalReason.OperatorError)}`
      + `;000123;11-09-26 15:02:37;50273226;${USN}`);
  });

  it('sells an item as name;tax;price*qty with the name padded to 36', async () => {
    await printer._addItem({ Text: 'Тест', TaxGroup: TaxGroup.TaxGroup2, UnitPrice: 0.01, Quantity: 1 });
    const { cmd, text } = only();
    expect(cmd).toBe(CMD.SellCorrection);
    expect(text).toBe(`${'Тест'.padEnd(36, ' ')};Б;0.01*1`);
  });

  it('folds an item discount into the same command', async () => {
    await printer._addItem({
      Text: 'Тест', TaxGroup: TaxGroup.TaxGroup2, UnitPrice: 10, Quantity: 1,
      PriceModifierType: PriceModifierType.DiscountAmount, PriceModifierValue: 2.5,
    });
    expect(only().text).toBe(`${'Тест'.padEnd(36, ' ')};Б;10.00*1:-2.50`);
  });

  it('uses a percent modifier with a comma', async () => {
    await printer._addItem({
      Text: 'Тест', TaxGroup: TaxGroup.TaxGroup2, UnitPrice: 10, Quantity: 1,
      PriceModifierType: PriceModifierType.DiscountPercent, PriceModifierValue: 5,
    });
    expect(only().text).toBe(`${'Тест'.padEnd(36, ' ')};Б;10.00*1,-5.00`);
  });

  it('sends a department as one raw byte, not as text', async () => {
    await printer._addItem({ Text: 'Тест', Department: 1, UnitPrice: 0.01, Quantity: 1 });
    const { cmd, raw } = only();
    expect(cmd).toBe(CMD.SellCorrectionDepartment);
    expect(raw[36]).toBe(0x3b);        // ';'
    expect(raw[37]).toBe(0x81);        // Dep01
  });

  it('pays as type;1;amount*', async () => {
    await printer._addPayment({ PaymentType: PaymentType.Cash, Amount: 0.01 });
    const { cmd, text } = only();
    expect(cmd).toBe(CMD.Payment);
    expect(text).toBe('0;1;0.01*');
  });

  it('applies a subtotal discount as 1;0:<amount>', async () => {
    await printer._addSubtotalChangeAmount(-2);
    const { cmd, text } = only();
    expect(cmd).toBe(CMD.Subtotal);
    expect(text).toBe('1;0:-2.00');
  });

  it('routes a subtotal-discount item to the subtotal command, not to a sale', async () => {
    vi.spyOn(printer, 'validateReceipt').mockReturnValue({ Ok: true });
    vi.spyOn(printer, '_getLastReceiptInfo').mockResolvedValue({});
    await printer.printReceipt({
      Operator: '1', UniqueSaleNumber: USN,
      Items: [{ Type: ItemType.DiscountAmount, Amount: 1.5 }],
      Payments: [],
    });
    expect(sent.some(c => c.cmd === CMD.Subtotal && c.text === '1;0:-1.50')).toBe(true);
    expect(sent.some(c => c.cmd === CMD.SellCorrection)).toBe(false);
  });

  it('moves cash with the non-fiscal RA/PO command, not with a payment line', async () => {
    await printer.printMoneyDeposit({ Amount: 5, Operator: '1', OperatorPassword: '0000' });
    let c = only();
    expect(c.cmd).toBe(CMD.NoFiscalRAorPO);
    expect(c.text).toBe('1;0000;0;5.00');

    sent = [];
    await printer.printMoneyWithdraw({ Amount: 5, Operator: '1', OperatorPassword: '0000' });
    c = only();
    expect(c.cmd).toBe(CMD.NoFiscalRAorPO);
    expect(c.text).toBe('1;0000;0;-5.00');
  });

  it('asks for the last receipt QR with its mandatory argument', async () => {
    await printer._getLastReceiptInfo();
    expect(sent[0].cmd).toBe(CMD.ReadLastQR);
    expect(sent[0].text).toBe('B');
  });

  it('sets the clock with a two-digit year', async () => {
    await printer.setDateTime({ DeviceDateTime: new Date(2026, 8, 11, 15, 2, 37) });
    expect(only().text).toBe('11-09-26 15:02:37');
  });

  it('never emits a tab — the separator that made the device ignore us', async () => {
    vi.spyOn(printer, 'validateReceipt').mockReturnValue({ Ok: true });
    vi.spyOn(printer, '_getLastReceiptInfo').mockResolvedValue({});
    await printer.printReceipt({
      Operator: '1', OperatorPassword: '0000', UniqueSaleNumber: USN,
      Items: [{ Type: ItemType.Sale, Text: 'Тест', TaxGroup: TaxGroup.TaxGroup2, UnitPrice: 0.01, Quantity: 1 }],
      Payments: [{ PaymentType: PaymentType.Cash, Amount: 0.01 }],
    });
    expect(sent.length).toBeGreaterThan(2);
    for (const c of sent) expect(c.text || '').not.toContain('\t');
  });
});
