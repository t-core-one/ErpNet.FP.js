import { describe, it, expect } from 'vitest';
import { BgDatecsXIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsXIslFiscalPrinter.js';
import { BgDatecsPIslFiscalPrinter } from '../../src/Drivers/BgDatecs/BgDatecsPIslFiscalPrinter.js';

/**
 * Fiscal memory report for a period, per protocol family.
 *
 * An FP-700X printed nothing for every short memory report: the X driver
 * inherited the P/C dialect (0x4F short, 0x5E detailed, "DDMMYY,DDMMYY"), and the
 * X family has no command 0x4F at all — it answered "invalid command". Its own
 * command 94 (0x5E) takes {Type}<SEP>{Start}<SEP>{End}<SEP> with DD-MM-YY dates
 * (Datecs FMP-350X/FP-700X programmer's manual). Both dialects are pinned here.
 */
function capture(cls) {
  const p = Object.create(cls.prototype);
  p.info = {};
  const sent = [];
  p._sendCommand = async (cmd, data, retries, timeout) => { sent.push({ cmd, data, retries, timeout }); return ''; };
  return { p, sent };
}

// Local dates, so the test does not depend on the machine's timezone.
const period = (extra = {}) => ({ StartDate: new Date(2026, 8, 1), EndDate: new Date(2026, 8, 30), ...extra });

describe('Datecs X: fiscal memory report by date (command 94)', () => {
  it('short: 0x5E, type 0, DD-MM-YY, tab-separated', async () => {
    const { p, sent } = capture(BgDatecsXIslFiscalPrinter);
    const status = await p.printMonthlyReport(period());
    expect(status.Ok).toBe(true);
    expect(sent).toEqual([{ cmd: 0x5E, data: '0\t01-09-26\t30-09-26\t', retries: 1, timeout: 90000 }]);
  });

  it('detailed: type 1 — in either request shape', async () => {
    for (const extra of [{ Detailed: true }, { Type: 'detailed' }]) {
      const { p, sent } = capture(BgDatecsXIslFiscalPrinter);
      await p.printMonthlyReport(period(extra));
      expect(sent[0].cmd).toBe(0x5E);
      expect(sent[0].data).toBe('1\t01-09-26\t30-09-26\t');
    }
  });

  it('never sends 0x4F, which the X family does not have', async () => {
    const { p, sent } = capture(BgDatecsXIslFiscalPrinter);
    await p.printMonthlyReport(period());
    expect(sent.map((s) => s.cmd)).not.toContain(0x4F);
  });

  it('a device rejection becomes an error, not a silent success', async () => {
    const p = Object.create(BgDatecsXIslFiscalPrinter.prototype);
    p.info = {};
    p._sendCommand = async () => { throw new Error('Device rejected command 0x5e with error code -111008'); };
    const status = await p.printMonthlyReport(period());
    expect(status.Ok).toBe(false);
    expect(JSON.stringify(status)).toMatch(/E402/);
  });

  it('still validates the period before touching the device', async () => {
    const { p, sent } = capture(BgDatecsXIslFiscalPrinter);
    const status = await p.printMonthlyReport({ StartDate: new Date(2026, 8, 30), EndDate: new Date(2026, 8, 1) });
    expect(status.Ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('Datecs P: the P/C dialect is unchanged', () => {
  it('short 0x4F / detailed 0x5E with DDMMYY,DDMMYY', async () => {
    const short = capture(BgDatecsPIslFiscalPrinter);
    await short.p.printMonthlyReport(period());
    expect(short.sent[0]).toMatchObject({ cmd: 0x4F, data: '010926,300926' });

    const detailed = capture(BgDatecsPIslFiscalPrinter);
    await detailed.p.printMonthlyReport(period({ Detailed: true }));
    expect(detailed.sent[0]).toMatchObject({ cmd: 0x5E, data: '010926,300926' });
  });
});
