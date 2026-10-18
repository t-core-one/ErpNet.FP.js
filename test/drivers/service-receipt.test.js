import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import printersRouter from '../../src/Routes/printers.js';
import { PrintJob, PrintJobAction } from '../../src/Service/PrintJob.js';
import { DeviceStatusWithReceiptInfo } from '../../src/Core/DeviceStatus.js';
import { BgIslFiscalPrinter, serviceReceiptOpenIn, fiscalReceiptOpenIn } from '../../src/Drivers/BgIslFiscalPrinter.js';
import {
  normalizeServiceReceiptLines,
  wrapWords,
  layoutServiceReceipt,
  MAX_SERVICE_RECEIPT_LINES,
  COPY_MARK,
} from '../../src/Helpers/serviceReceipt.js';
import { BgDatecsPIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsPIslFiscalPrinter.js';
import { BgDatecsXIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsXIslFiscalPrinter.js';
import { BgSisJsonFiscalPrinter } from '../../src/Drivers/BgSis/BgSisJsonFiscalPrinter.js';

/**
 * Service receipts (СЛУЖЕБЕН БОН) — e.g. a ПКО/РКО voucher for a cash movement.
 *
 * The property that matters most is that the device is NEVER left with an open
 * service receipt: it would then refuse every fiscal receipt until someone
 * closed it. That is why this is one job with close-on-failure, instead of the
 * POS chaining /rawrequest calls.
 */

const OPEN = 0x26;
const CLOSE = 0x27;
const TEXT = 0x2a;
const ABORT_FISCAL = 0x3c;
const LAST_DOCUMENT = 0x71;
const GET_DATETIME = 0x3e;

/**
 * A printer with a scripted device: `script(cmd, data, n)` may throw or return a Buffer.
 *
 * Like the real devices, every answer carries status bytes, and byte 2 bit 5
 * says whether a service receipt is open (0xa0 while open, 0x80 otherwise —
 * as measured on an FP-700, an FP-800 and an FP-700X). A command that throws
 * models a lost answer: the status is not updated.
 */
function device(cls, info = {}, script = () => Buffer.alloc(0)) {
  const p = Object.create(cls.prototype);
  p.info = { SupportsServiceReceipt: true, CommentTextMaxLength: 46, ...info };
  const sent = [];
  const state = { slipOpen: false };
  const report = () => {
    p._lastStatusBytes = Buffer.from([0x88, 0x80, state.slipOpen ? 0xa0 : 0x80, 0xea, 0x86, 0x9a]);
  };
  p._sendCommand = async (cmd, data) => {
    sent.push({ cmd, data });
    const answer = script(cmd, data, sent.length);
    if (cmd === OPEN) state.slipOpen = true;
    if (cmd === CLOSE) state.slipOpen = false;
    report();
    return answer;
  };
  return { p, sent, state, report };
}

describe('normalizeServiceReceiptLines', () => {
  it('accepts strings and styled objects, in either key case', () => {
    const { lines } = normalizeServiceReceiptLines({
      Lines: ['РКО № 0000001', { Text: 'Сума: 150.00', Bold: true, Align: 'Right' }, { text: 'x', doubleHeight: true, align: 'centre' }],
    });
    expect(lines).toEqual([
      { Text: 'РКО № 0000001', Bold: false, DoubleHeight: false, Align: 'left' },
      { Text: 'Сума: 150.00', Bold: true, DoubleHeight: false, Align: 'right' },
      { Text: 'x', Bold: false, DoubleHeight: true, Align: 'center' },
    ]);
  });

  it('splits embedded newlines into lines with the same style', () => {
    const { lines } = normalizeServiceReceiptLines({ lines: [{ Text: 'a\nb\r\nc', Bold: true }] });
    expect(lines.map((l) => l.Text)).toEqual(['a', 'b', 'c']);
    expect(lines.every((l) => l.Bold)).toBe(true);
  });

  it('removes control characters — a TAB would shift every X-protocol field after it', () => {
    const { lines } = normalizeServiceReceiptLines({ Lines: ['Име:\tИван\x01\x7F   '] });
    expect(lines[0].Text).toBe('Име: Иван');
  });

  it('marks a reprint with a centred КОПИЕ before and after the lines', () => {
    const { lines } = normalizeServiceReceiptLines({ Lines: ['РКО № 07000045'], Copy: true });
    expect(lines.map((l) => l.Text)).toEqual([COPY_MARK, 'РКО № 07000045', COPY_MARK]);
    expect(lines[0]).toMatchObject({ Bold: true, DoubleHeight: true, Align: 'center' });
    expect(normalizeServiceReceiptLines({ lines: ['x'], copy: true }).lines).toHaveLength(3);
    expect(normalizeServiceReceiptLines({ Lines: ['x'] }).lines).toHaveLength(1);
  });

  it('refuses a missing or empty list', () => {
    expect(normalizeServiceReceiptLines({}).error).toMatch(/Lines is required/);
    expect(normalizeServiceReceiptLines({ Lines: [] }).error).toMatch(/Lines is required/);
    expect(normalizeServiceReceiptLines(null).error).toMatch(/Lines is required/);
  });
});

describe('wrapWords / layoutServiceReceipt', () => {
  it('wraps at word boundaries and cuts only a word longer than the line', () => {
    expect(wrapWords('Получил сумата от касиера', 12)).toEqual(['Получил', 'сумата от', 'касиера']);
    expect(wrapWords('ABCDEFGHIJ', 4)).toEqual(['ABCD', 'EFGH', 'IJ']);
  });

  it('keeps runs of spaces inside a line (signature lines depend on them)', () => {
    expect(wrapWords('Получил:      ........', 40)).toEqual(['Получил:      ........']);
  });

  it('pads centre/right alignment when the device cannot align', () => {
    const out = layoutServiceReceipt(
      [{ Text: 'AB', Align: 'center' }, { Text: 'AB', Align: 'right' }, { Text: 'AB', Align: 'left' }], 6, true,
    );
    expect(out.map((l) => l.Text)).toEqual(['  AB', '    AB', 'AB']);
  });

  it('leaves alignment to the device when it aligns natively', () => {
    const out = layoutServiceReceipt([{ Text: 'AB', Align: 'right' }], 6, false);
    expect(out[0].Text).toBe('AB');
  });

  it('refuses a slip longer than the ceiling', () => {
    const many = Array.from({ length: MAX_SERVICE_RECEIPT_LINES + 1 }, () => ({ Text: 'x', Align: 'left' }));
    expect(() => layoutServiceReceipt(many, 40, true)).toThrow(/at most/);
  });
});

describe('Datecs P (FP-700, FP-800): commands 38 / 42 / 39', () => {
  it('opens, prints each line as plain text, closes — and reports the document number', async () => {
    // The close answers "Allreceipt" — receipts since the last Z report, so a
    // shop's first slip after a Z says 0001. Seen on an FP-700 and an FP-800.
    // The document number comes from 0x71, as for a fiscal receipt.
    const { p, sent } = device(BgDatecsPIslFiscalPrinter, {}, (cmd) => {
      if (cmd === CLOSE) return Buffer.from('0001');
      if (cmd === LAST_DOCUMENT) return Buffer.from('0004321');
      return Buffer.alloc(0);
    });
    const status = await p.printServiceReceipt({ Lines: ['РКО № 0000001', 'Сума: 150.00'] });
    expect(status.Ok).toBe(true);
    expect(sent).toEqual([
      { cmd: OPEN, data: null },
      { cmd: TEXT, data: 'РКО № 0000001' },
      { cmd: TEXT, data: 'Сума: 150.00' },
      { cmd: CLOSE, data: null },
      { cmd: LAST_DOCUMENT, data: null },
    ]);
    expect(status.SlipNumber).toBe('0004321');
    expect(status.LinesPrinted).toBe(2);
    expect(status.Printed).toBe(true);
    expect(status.Closed).toBe(true);
  });

  it('a slip that printed stays printed when the document number cannot be read', async () => {
    const { p } = device(BgDatecsPIslFiscalPrinter, {}, (cmd) => {
      if (cmd === LAST_DOCUMENT) throw new Error('no answer');
      return Buffer.alloc(0);
    });
    const status = await p.printServiceReceipt({ Lines: ['x'] });
    expect(status.Ok).toBe(true);
    expect(status.Printed).toBe(true);
    expect(status.Closed).toBe(true);
    expect(status.SlipNumber).toBe('');
    expect(JSON.stringify(status)).toMatch(/W704/);
  });

  it('wraps to the comment width minus the two "#" markers this dialect prints', async () => {
    const { p, sent } = device(BgDatecsPIslFiscalPrinter, { CommentTextMaxLength: 46 });
    await p.printServiceReceipt({ Lines: ['x'.repeat(50)] });
    const texts = sent.filter((s) => s.cmd === TEXT).map((s) => s.data);
    expect(texts).toEqual(['x'.repeat(44), 'x'.repeat(6)]);
  });

  it('centres with spaces, since this dialect has no alignment parameter', async () => {
    const { p, sent } = device(BgDatecsPIslFiscalPrinter, { CommentTextMaxLength: 22 }); // width 20
    await p.printServiceReceipt({ Lines: [{ Text: 'РКО', Align: 'center' }, { Text: 'РКО', Align: 'right' }] });
    const texts = sent.filter((s) => s.cmd === TEXT).map((s) => s.data);
    expect(texts).toEqual([' '.repeat(8) + 'РКО', ' '.repeat(17) + 'РКО']);
  });
});

describe('Datecs X (FP-700X): commands 38 / 42 / 39', () => {
  it('sends the tab-separated X fields, with native bold and alignment', async () => {
    const { p, sent } = device(BgDatecsXIslFiscalPrinter, { CommentTextMaxLength: 46 },
      (cmd) => (cmd === CLOSE ? Buffer.from('0\t1734\t') : Buffer.from('0\t')));
    const status = await p.printServiceReceipt({ Lines: [{ Text: 'РКО № 0000001', Bold: true, Align: 'center' }, 'Сума: 150.00'] });
    expect(status.Ok).toBe(true);
    expect(sent.filter((s) => s.cmd === TEXT).map((s) => s.data)).toEqual([
      'РКО № 0000001\t1\t\t\t\t1\t',
      'Сума: 150.00\t\t\t\t\t0\t',
    ]);
    expect(status.SlipNumber).toBe('1734');
    expect(sent.map((s) => s.cmd)).not.toContain(LAST_DOCUMENT); // the X family rejects 0x71
  });

  it('uses the full PrintColumns−2 width — no "#" markers on this family', async () => {
    const { p, sent } = device(BgDatecsXIslFiscalPrinter, { CommentTextMaxLength: 46 });
    await p.printServiceReceipt({ Lines: ['x'.repeat(46)] });
    expect(sent.filter((s) => s.cmd === TEXT)).toHaveLength(1);
  });
});

describe('never leaves the device blocked', () => {
  it('closes the slip if a line fails, and says only part of it printed', async () => {
    const { p, sent } = device(BgDatecsPIslFiscalPrinter, {}, (cmd, data) => {
      if (cmd === TEXT && data === 'line 2') throw new Error('paper out');
      return Buffer.alloc(0);
    });
    const status = await p.printServiceReceipt({ Lines: ['line 1', 'line 2', 'line 3'] });
    expect(sent.map((s) => s.cmd)).toEqual([OPEN, TEXT, TEXT, CLOSE]);
    expect(status.Ok).toBe(false);
    const json = JSON.stringify(status);
    expect(json).toMatch(/E702/);
    expect(json).toMatch(/W702/);
    expect(status.Printed).toBe(false);
    expect(status.Closed).toBe(true);
    expect(status.LinesPrinted).toBe(1);
  });

  it('says plainly when even the close fails — the device would refuse fiscal receipts', async () => {
    const { p } = device(BgDatecsPIslFiscalPrinter, {}, (cmd) => {
      if (cmd === TEXT || cmd === CLOSE) throw new Error('no answer');
      return Buffer.alloc(0);
    });
    const status = await p.printServiceReceipt({ Lines: ['line 1'] });
    expect(JSON.stringify(status)).toMatch(/E703/);
    expect(status.Printed).toBe(false);
    expect(status.Closed).toBe(false);
  });

  it('clears a service receipt left open by an interrupted attempt, then prints', async () => {
    let opens = 0;
    const { p, sent } = device(BgDatecsPIslFiscalPrinter, {}, (cmd) => {
      if (cmd === OPEN && ++opens === 1) throw new Error('service receipt already open');
      return Buffer.alloc(0);
    });
    const status = await p.printServiceReceipt({ Lines: ['x'] });
    expect(sent.map((s) => s.cmd)).toEqual([OPEN, CLOSE, OPEN, TEXT, CLOSE, LAST_DOCUMENT]);
    expect(status.Ok).toBe(true);
  });

  it('never touches an open FISCAL receipt — reports the refusal instead', async () => {
    const { p, sent } = device(BgDatecsPIslFiscalPrinter, {}, (cmd) => {
      if (cmd === OPEN) throw new Error('fiscal receipt is open');
      if (cmd === CLOSE) throw new Error('no service receipt is open');
      return Buffer.alloc(0);
    });
    const status = await p.printServiceReceipt({ Lines: ['x'] });
    expect(sent.map((s) => s.cmd)).toEqual([OPEN, CLOSE]);
    expect(sent.map((s) => s.cmd)).not.toContain(ABORT_FISCAL);
    expect(JSON.stringify(status)).toMatch(/fiscal receipt is open/);
    expect(status.Printed).toBe(false);
    expect(status.Closed).toBe(true);
  });
});

describe('a slip left open (E703) never stops the shop selling', () => {
  // The state after an E703: the device has a service receipt open and refuses
  // every fiscal receipt until it is closed.
  function blocked(script) {
    const d = device(BgDatecsPIslFiscalPrinter, {}, script);
    d.state.slipOpen = true;
    d.report();
    d.sent.length = 0;
    return d;
  }

  it('closes it after confirming with a fresh status read', async () => {
    const { p, sent } = blocked();
    expect(await p.clearStaleServiceReceipt()).toEqual({ closed: true });
    expect(sent.map((x) => x.cmd)).toEqual([GET_DATETIME, CLOSE]);
  });

  it('costs nothing when the last status shows no open slip', async () => {
    const { p, sent } = device(BgDatecsPIslFiscalPrinter);
    p._sendCommand(GET_DATETIME); // a keep-alive: status now known and clean
    sent.length = 0;
    expect(await p.clearStaleServiceReceipt()).toBeNull();
    expect(sent).toEqual([]);
  });

  it('looks once after a restart, when no status has been seen yet', async () => {
    const { p, sent } = device(BgDatecsPIslFiscalPrinter);
    p._lastStatusBytes = null;
    expect(await p.clearStaleServiceReceipt()).toBeNull();
    expect(sent.map((x) => x.cmd)).toEqual([GET_DATETIME]);
    sent.length = 0;
    expect(await p.clearStaleServiceReceipt()).toBeNull();
    expect(sent).toEqual([]);
  });

  it('does not close anything when the fresh read shows the slip is already gone', async () => {
    const d = blocked();
    d.state.slipOpen = false; // closed meanwhile, e.g. by the cashier at the device
    expect(await d.p.clearStaleServiceReceipt()).toBeNull();
    expect(d.sent.map((x) => x.cmd)).toEqual([GET_DATETIME]);
  });

  it('reports an error, not success, while the device still cannot close it', async () => {
    const { p } = blocked((cmd) => {
      if (cmd === CLOSE) throw new Error('E301 No paper');
      return Buffer.alloc(0);
    });
    expect(await p.clearStaleServiceReceipt()).toEqual({ error: 'E301 No paper' });
  });

  it('trusts the device state over a refused close answer', async () => {
    // Refused (e.g. low-paper status on the answer) but the slip did close.
    const d = blocked((cmd) => {
      if (cmd === CLOSE) {
        d.state.slipOpen = false;
        d.report();
        throw new Error('Device rejected command 0x27');
      }
      return Buffer.alloc(0);
    });
    expect(await d.p.clearStaleServiceReceipt()).toEqual({ closed: true });
  });

  it('is a no-op on drivers without verified service receipts', async () => {
    const { p, sent } = blocked();
    p.info.SupportsServiceReceipt = false;
    expect(await p.clearStaleServiceReceipt()).toBeNull();
    expect(sent).toEqual([]);
  });

  it('"Reset device" unblocks it, without aborting a fiscal receipt that is not open', async () => {
    const { p, sent } = blocked();
    const status = await p.reset();
    expect(sent.map((x) => x.cmd)).toEqual([GET_DATETIME, CLOSE]);
    expect(sent.map((x) => x.cmd)).not.toContain(ABORT_FISCAL);
    expect(status.Ok).toBe(true);
    expect(JSON.stringify(status)).toMatch(/W703/);
  });

  it('"Reset device" still aborts a fiscal receipt when no slip is open', async () => {
    const { p, sent } = device(BgDatecsPIslFiscalPrinter);
    const status = await p.reset();
    expect(sent.map((x) => x.cmd)).toEqual([GET_DATETIME, ABORT_FISCAL]);
    expect(status.Ok).toBe(true);
  });

  it('"Reset device" says what blocks it when the slip cannot be closed', async () => {
    const { p, sent } = blocked((cmd) => {
      if (cmd === CLOSE) throw new Error('E301 No paper');
      return Buffer.alloc(0);
    });
    const status = await p.reset();
    expect(status.Ok).toBe(false);
    expect(JSON.stringify(status)).toMatch(/E703.*paper/);
    expect(sent.map((x) => x.cmd)).not.toContain(ABORT_FISCAL);
  });

  it('a failed close whose answer shows the slip closed is not an E703', async () => {
    const d = device(BgDatecsPIslFiscalPrinter, {}, (cmd, data) => {
      if (cmd === TEXT && data === 'line 2') throw new Error('paper out');
      if (cmd === CLOSE) {
        d.state.slipOpen = false;
        d.report();
        throw new Error('Device rejected command 0x27');
      }
      return Buffer.alloc(0);
    });
    const status = await d.p.printServiceReceipt({ Lines: ['line 1', 'line 2'] });
    expect(status.Closed).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/E703/);
    expect(JSON.stringify(status)).toMatch(/W702/);
  });
});

describe('PrintJob closes a stale slip before jobs the device would refuse', () => {
  function printer(stale) {
    const receipt = new DeviceStatusWithReceiptInfo();
    return {
      clearStaleServiceReceipt: vi.fn(async () => {
        if (stale instanceof Error) throw stale;
        return stale;
      }),
      printReceipt: vi.fn(async () => receipt),
      checkStatus: vi.fn(async () => new DeviceStatusWithReceiptInfo()),
    };
  }

  it('closes it, prints the sale, and says so', async () => {
    const p = printer({ closed: true });
    const status = await new PrintJob({ printer: p, action: PrintJobAction.Receipt, document: {} }).run();
    expect(p.printReceipt).toHaveBeenCalledOnce();
    expect(status.Ok).toBe(true);
    expect(JSON.stringify(status)).toMatch(/W703/);
  });

  it('does not attempt the sale while the slip cannot be closed', async () => {
    const p = printer({ error: 'E301 No paper' });
    const status = await new PrintJob({ printer: p, action: PrintJobAction.Receipt, document: {} }).run();
    expect(p.printReceipt).not.toHaveBeenCalled();
    expect(status.Ok).toBe(false);
    expect(JSON.stringify(status)).toMatch(/E703.*No paper/);
  });

  it('a failing check never stops the sale', async () => {
    const p = printer(new Error('bug'));
    const status = await new PrintJob({ printer: p, action: PrintJobAction.Receipt, document: {} }).run();
    expect(p.printReceipt).toHaveBeenCalledOnce();
    expect(status.Ok).toBe(true);
  });

  it('leaves read-only jobs alone', async () => {
    const p = printer({ closed: true });
    await new PrintJob({ printer: p, action: PrintJobAction.Status }).run();
    expect(p.clearStaleServiceReceipt).not.toHaveBeenCalled();
  });
});

describe('document state bits, on status bytes captured from live devices', () => {
  const hex = (h) => Buffer.from(h, 'hex');
  it.each([
    ['FP-800 idle', '888080ea869a', false, false],
    ['FP-800 during a service receipt', '8880a0ea869a', true, false],
    ['FP-800 during a fiscal receipt', '888088ea869a', false, true],
    ['FP-700 during a service receipt, low paper', '8880a2ea869a', true, false],
    ['FP-700 idle, low paper', '888082ea869a', false, false],
    ['FP-700X idle', '80808080869a8080', false, false],
    ['FP-700X during a service receipt', '8080a080869a8080', true, false],
  ])('%s', (_name, status, service, fiscal) => {
    expect(serviceReceiptOpenIn(hex(status))).toBe(service);
    expect(fiscalReceiptOpenIn(hex(status))).toBe(fiscal);
  });

  it('no status yet means no evidence of an open slip', () => {
    expect(serviceReceiptOpenIn(null)).toBe(false);
    expect(serviceReceiptOpenIn(Buffer.from([0x80]))).toBe(false);
  });
});

describe('_sendCommand records the document state from every answer', () => {
  // PREAMBLE LEN SEQ CMD [data] SEPARATOR status×6 POSTAMBLE BCC×4 TERMINATOR
  function frame(status) {
    return Buffer.concat([
      Buffer.from([0x01, 0x20 + 4 + 7, 0x21, 0x4a]),
      Buffer.from([0x04, ...status]),
      Buffer.from([0x05, 0x30, 0x30, 0x30, 0x30, 0x03]),
    ]);
  }
  function printerAnswering(status) {
    let reads = 0;
    const channel = {
      write: vi.fn(),
      read: vi.fn(async () => (reads++ === 0 ? frame(status) : Buffer.alloc(0))),
      descriptor: 'test',
    };
    return new BgIslFiscalPrinter(channel, null);
  }

  it('on a normal answer', async () => {
    const p = printerAnswering([0x88, 0x80, 0xa0, 0xea, 0x86, 0x9a]); // FP-800 mid-slip
    await p._sendCommand(0x3e, null, 1, 200);
    expect(serviceReceiptOpenIn(p._lastStatusBytes)).toBe(true);
  });

  it('on a refusal too — the state is still the truth', async () => {
    const p = printerAnswering([0x88, 0x80, 0xa1, 0xea, 0x86, 0x9a]); // + out of paper
    await expect(p._sendCommand(0x27, null, 1, 200)).rejects.toThrow(/paper/);
    expect(serviceReceiptOpenIn(p._lastStatusBytes)).toBe(true);
  });
});

describe('only where verified', () => {
  it('refuses without touching the device when the driver does not advertise it', async () => {
    const { p, sent } = device(BgDatecsPIslFiscalPrinter, { SupportsServiceReceipt: false });
    const status = await p.printServiceReceipt({ Lines: ['x'] });
    expect(JSON.stringify(status)).toMatch(/E700/);
    expect(sent).toEqual([]);
  });

  it('a driver without service receipts says so', async () => {
    const p = Object.create(BgSisJsonFiscalPrinter.prototype);
    const status = await p.printServiceReceipt({ Lines: ['x'] });
    expect(JSON.stringify(status)).toMatch(/E700/);
  });

  it('invalid input is refused before the device is touched', async () => {
    const { p, sent } = device(BgDatecsXIslFiscalPrinter);
    const status = await p.printServiceReceipt({ Lines: [] });
    expect(JSON.stringify(status)).toMatch(/E701/);
    expect(sent).toEqual([]);
  });
});

describe('POST /printers/:id/servicereceipt', () => {
  function app(service) {
    const a = express();
    a.use(express.json());
    a.locals.service = service;
    a.use('/printers', printersRouter);
    return a;
  }

  it('runs ONE queued job with the ServiceReceipt action and the body as the document', async () => {
    const runAsync = vi.fn().mockResolvedValue({ ok: true });
    const service = { isReady: true, printers: { DT123456: {} }, runAsync };
    const body = { Lines: ['РКО № 0000001'] };
    const res = await request(app(service)).post('/printers/DT123456/servicereceipt?taskId=t1').send(body);
    expect(res.status).toBe(200);
    expect(runAsync).toHaveBeenCalledOnce();
    const job = runAsync.mock.calls[0][0];
    expect(job.action).toBe(PrintJobAction.ServiceReceipt);
    expect(job.document).toEqual(body);
    expect(job.taskId).toBe('t1');
  });

  it('404s for an unknown printer', async () => {
    const service = { isReady: true, printers: {}, runAsync: vi.fn() };
    const res = await request(app(service)).post('/printers/NOPE/servicereceipt').send({ Lines: ['x'] });
    expect(res.status).toBe(404);
  });
});
