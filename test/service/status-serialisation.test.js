import { describe, it, expect, vi } from 'vitest';
import { PrintJob, PrintJobAction } from '../../src/Service/PrintJob.js';
import { KeepAliveService } from '../../src/Service/KeepAliveService.js';
import { BgIslFiscalPrinter } from '../../src/Drivers/BgIslFiscalPrinter.js';

/**
 * Everything that touches the port must go through the one job queue.
 *
 * The queue already serialised every route except GET /:id/status, and the
 * keep-alive timer bypassed it entirely. On 2026-09-05 a keep-alive 0x3E landed
 * inside a running Z report; both replies accumulated in the channel's single
 * receive buffer, the parser sliced across the pair, and the Z report's response
 * was destroyed — the request returned 200 having never sent its command, and a
 * second Z closed the fiscal day a second time.
 *
 * An earlier attempt at this put a lock on the channel instead. That broke
 * device detection outright: detection deliberately shares one channel across
 * all driver probes and abandons each on a 5s race without cancelling it, so an
 * abandoned probe held the lock and starved every driver after it. The regression
 * is covered below, because it took a shop offline.
 */
describe('Status is a queued job', () => {
  it('is dispatched to checkStatus', async () => {
    const printer = { checkStatus: vi.fn().mockResolvedValue({ Ok: true }) };
    const job = new PrintJob({ printer, action: PrintJobAction.Status, document: null });
    await job.run();
    expect(printer.checkStatus).toHaveBeenCalledOnce();
  });

  it('the keep-alive enqueues rather than touching the printer directly', async () => {
    const printer = { checkStatus: vi.fn().mockResolvedValue({ Ok: true, Messages: [] }) };
    const runAsync = vi.fn().mockResolvedValue({ Ok: true, Messages: [] });
    const controller = { isReady: true, printers: { DT408090: printer }, runAsync };

    await new KeepAliveService(controller)._tick();

    expect(runAsync).toHaveBeenCalledOnce();
    const job = runAsync.mock.calls[0][0];
    expect(job.action).toBe(PrintJobAction.Status);
    expect(job.printer).toBe(printer);
    // It must not reach around the queue.
    expect(printer.checkStatus).not.toHaveBeenCalled();
  });

  it('does nothing while the service is not ready', async () => {
    const runAsync = vi.fn();
    await new KeepAliveService({ isReady: false, printers: {}, runAsync })._tick();
    expect(runAsync).not.toHaveBeenCalled();
  });
});

describe('keep-alive reporting', () => {
  const controllerReturning = (...results) => {
    const runAsync = vi.fn();
    results.forEach((r) => runAsync.mockResolvedValueOnce(r));
    return { isReady: true, printers: { DT408090: {} }, runAsync };
  };

  it('warns when the device stops answering instead of staying silent', async () => {
    const logger = (await import('../../src/logger.js')).default;
    const warnings = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((m) => warnings.push(m));
    const ka = new KeepAliveService(controllerReturning(
      { Ok: false, Messages: [{ Type: 'error', Code: 'E001', Text: 'no response from device' }] },
    ));
    await ka._tick();
    expect(warnings.some((w) => /not answering/.test(w) && /E001/.test(w))).toBe(true);
    spy.mockRestore();
  });

  it('treats a job that never completed as a failure', async () => {
    const logger = (await import('../../src/logger.js')).default;
    const warnings = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((m) => warnings.push(m));
    // runAsync returns a bare { taskId } when the job outran its timeout.
    await new KeepAliveService(controllerReturning({ taskId: 'abc' }))._tick();
    expect(warnings.some((w) => /did not complete in time/.test(w))).toBe(true);
    spy.mockRestore();
  });

  it('stays quiet on a second consecutive failure — it is the same outage', async () => {
    const logger = (await import('../../src/logger.js')).default;
    const warnings = [];
    const spy = vi.spyOn(logger, 'warn').mockImplementation((m) => warnings.push(m));
    const bad = { Ok: false, Messages: [{ Type: 'error', Code: 'E001', Text: 'gone' }] };
    const ka = new KeepAliveService(controllerReturning(bad, bad));
    await ka._tick();
    warnings.length = 0;
    await ka._tick();
    expect(warnings).toHaveLength(0);
    spy.mockRestore();
  });

  it('says so when the device comes back', async () => {
    const logger = (await import('../../src/logger.js')).default;
    const infos = [];
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation((m) => infos.push(m));
    const ka = new KeepAliveService(controllerReturning(
      { Ok: false, Messages: [{ Type: 'error', Code: 'E001', Text: 'gone' }] },
      { Ok: true, Messages: [] },
    ));
    await ka._tick();
    await ka._tick();
    expect(infos.some((m) => /answering again/.test(m))).toBe(true);
    warn.mockRestore(); info.mockRestore();
  });
});

/**
 * The regression guard. Detection shares one channel across every driver probe
 * and abandons each probe on a timeout without cancelling it. Nothing in the
 * send path may therefore hold a resource across probes, or the abandoned probe
 * starves the drivers that follow and the device is never found.
 */
describe('driver send path holds nothing across probes', () => {
  it('a probe abandoned mid-command does not block the next driver', async () => {
    // A channel that never answers — exactly an abandoned probe against a device
    // that does not speak this dialect. Its command runs the full timeout.
    const silent = {
      write: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      descriptor: '/dev/ttyUSB0',
    };

    const STRANDED_MS = 1500;
    const abandoned = new BgIslFiscalPrinter(silent, null);
    // Fire and forget, exactly as Promise.race leaves it during detection.
    const stranded = abandoned._sendCommand(0x5a, '1', 1, STRANDED_MS).catch(() => {});

    // The next driver must reach the port straight away. Under a channel-wide
    // lock it would instead queue behind the abandoned probe — which is what
    // took a shop offline: every driver after the first timed out still waiting
    // for the lock, and the device was reported as not found.
    const started = Date.now();
    const second = new BgIslFiscalPrinter(silent, null);
    await second._sendCommand(0x5a, '1', 1, 100).catch(() => {});
    const waited = Date.now() - started;

    expect(silent.write).toHaveBeenCalledTimes(2);
    expect(waited).toBeLessThan(STRANDED_MS / 2);

    await stranded;
  });
});
