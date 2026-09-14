import { describe, it, expect, vi, beforeEach } from 'vitest';
import iconv from 'iconv-lite';
import { BgTremolZfpFiscalPrinter, } from '../../src/Drivers/BgTremol/BgTremolZfpFiscalPrinter.js';
import { CMD, parseQrDateTime } from '../../src/Drivers/BgZfp/BgZfpFiscalPrinter.js';
import { ReversalReason } from '../../src/Core/ReversalReceipt.js';

const channel = { write: async () => {}, read: async () => Buffer.alloc(0), descriptor: 'test' };
// Captured from an FP-28: FM * receipt no * date * time * amount.
const REAL_QR = '50273226*000020*2026-09-14*11:11:41*0.01';

describe('last-receipt QR date', () => {
  it('reads the ISO shape the device sends', () => {
    const d = parseQrDateTime('2026-09-14', '11:11:41');
    expect(d).toBeInstanceOf(Date);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()])
      .toEqual([2026, 9, 14, 11, 11, 41]);
  });

  it('still reads the compact DDMMYY / HHMMSS shape', () => {
    const d = parseQrDateTime('140926', '111141');
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()])
      .toEqual([2026, 9, 14, 11, 11, 41]);
  });

  it('returns null rather than an Invalid Date, which would serialise to null silently', () => {
    expect(parseQrDateTime('not-a-date', '11:11:41')).toBeNull();
    expect(parseQrDateTime('2026-09-14', 'rubbish')).toBeNull();
    expect(parseQrDateTime('', '')).toBeNull();
  });

  it('gives _getLastReceiptInfo a real timestamp from the captured QR', async () => {
    const printer = new BgTremolZfpFiscalPrinter(channel, null);
    vi.spyOn(printer, '_sendCommand').mockResolvedValue(iconv.encode(REAL_QR, 'cp1251'));
    const info = await printer._getLastReceiptInfo();
    expect(info.ReceiptNumber).toBe('000020');
    expect(info.FiscalMemorySerialNumber).toBe('50273226');
    expect(info.ReceiptAmount).toBe(0.01);
    expect(info.ReceiptDateTime).toBeInstanceOf(Date);
    // The bug: an Invalid Date here JSON-serialises to null, so the caller
    // stored no time and a later storno sent an empty field to the device.
    expect(JSON.parse(JSON.stringify({ d: info.ReceiptDateTime })).d).not.toBeNull();
  });
});

describe('reversal header completeness', () => {
  let printer, sent;
  const USN = 'ZK212247-0015-0000002';
  const complete = {
    Reason: ReversalReason.OperatorError,
    ReceiptNumber: '000019',
    ReceiptDateTime: new Date(2026, 8, 14, 11, 11, 41),
    FiscalMemorySerialNumber: '50273226',
  };

  beforeEach(() => {
    printer = new BgTremolZfpFiscalPrinter(channel, null);
    sent = [];
    vi.spyOn(printer, '_sendCommand').mockImplementation(async (cmd, data) => {
      sent.push({ cmd, text: data ? iconv.decode(data, 'cp1251') : null });
      return Buffer.alloc(0);
    });
  });

  it('builds the full reversal header when the reference is complete', async () => {
    await printer._openReceipt({ Operator: '1', OperatorPassword: '0000', UniqueSaleNumber: USN }, true, complete);
    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toBe(CMD.OpenReceipt);
    expect(sent[0].text).toBe(`1;0000;1;1;D;0;000019;14-09-26 11:11:41;50273226;${USN}`);
  });

  for (const [field, patch] of [
    ['receiptDateTime', { ReceiptDateTime: null }],
    ['receiptDateTime', { ReceiptDateTime: '' }],
    ['receiptNumber', { ReceiptNumber: '' }],
    ['fiscalMemorySerialNumber', { FiscalMemorySerialNumber: '' }],
  ]) {
    it(`refuses, and sends nothing, when ${field} is missing (${JSON.stringify(patch)})`, async () => {
      await expect(
        printer._openReceipt({ Operator: '1', UniqueSaleNumber: USN }, true, { ...complete, ...patch })
      ).rejects.toThrow(new RegExp(field));
      // The point of the guard: the device never sees the malformed header.
      expect(sent).toHaveLength(0);
    });
  }

  it('surfaces the refusal as a storno failure rather than faulting the device', async () => {
    vi.spyOn(printer, 'validateReversalReceipt').mockReturnValue({ Ok: true });
    const status = await printer.printReversalReceipt({
      UniqueSaleNumber: USN, Items: [], Payments: [],
      ...complete, ReceiptDateTime: null,
    });
    expect(status.Ok).toBe(false);
    expect(status.Messages.map(m => m.Text).join(' ')).toMatch(/receiptDateTime/);
    expect(sent.filter(c => c.cmd === CMD.OpenReceipt)).toHaveLength(0);
  });
});
