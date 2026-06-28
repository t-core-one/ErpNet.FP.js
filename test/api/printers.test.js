import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import printersRouter from '../../src/Routes/printers.js';
import { toCamelCase } from '../../src/Helpers/camelCase.js';
import { PrintJobAction } from '../../src/Service/PrintJob.js';
import { DeviceStatusWithReceiptInfo } from '../../src/Core/DeviceStatus.js';

function createApp(mockService) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const orig = res.json.bind(res);
    res.json = (data) => orig(toCamelCase(data));
    next();
  });
  app.locals.service = mockService;
  app.get('/printers/taskinfo', (req, res) => {
    res.json(mockService.getTaskInfo?.(req.query.id) ?? {});
  });
  app.use('/printers', printersRouter);
  return app;
}

function makeStatus(ok = true) {
  const s = new DeviceStatusWithReceiptInfo();
  if (!ok) s.addError('E999', 'Test error');
  return s;
}

function makeService(overrides = {}) {
  return {
    isReady: true,
    printers: { DT970048: {} },
    printersInfo: {
      DT970048: { SerialNumber: 'DT970048', Model: 'FP-700', Manufacturer: 'Datecs' },
    },
    runAsync: vi.fn().mockResolvedValue(makeStatus()),
    ...overrides,
  };
}

// ── GET /printers ─────────────────────────────────────────────────────────

describe('GET /printers', () => {
  it('returns 405 when service is not ready', async () => {
    const app = createApp({ isReady: false });
    const res = await request(app).get('/printers');
    expect(res.status).toBe(405);
  });

  it('returns the printer list when ready', async () => {
    const app = createApp(makeService());
    const res = await request(app).get('/printers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('DT970048');
  });

  it('camelCases printer info properties', async () => {
    const app = createApp(makeService());
    const res = await request(app).get('/printers');
    const info = res.body.DT970048;
    expect(info).toHaveProperty('serialNumber', 'DT970048');
    expect(info).not.toHaveProperty('SerialNumber');
  });

  it('preserves the serial-number object key (no lowercase)', async () => {
    const app = createApp(makeService());
    const res = await request(app).get('/printers');
    expect(res.body).toHaveProperty('DT970048');
    expect(res.body).not.toHaveProperty('dT970048');
  });
});

// ── GET /printers/:id ─────────────────────────────────────────────────────

describe('GET /printers/:id', () => {
  it('returns 404 for an unknown printer', async () => {
    const app = createApp(makeService());
    const res = await request(app).get('/printers/UNKNOWN');
    expect(res.status).toBe(404);
  });

  it('returns 200 with printer info for a known printer', async () => {
    const app = createApp(makeService());
    const res = await request(app).get('/printers/DT970048');
    expect(res.status).toBe(200);
    expect(res.body.serialNumber).toBe('DT970048');
    expect(res.body.model).toBe('FP-700');
  });
});

// ── POST /printers/:id/xreport ────────────────────────────────────────────

describe('POST /printers/:id/xreport', () => {
  it('returns 404 for unknown printer', async () => {
    const res = await request(createApp(makeService())).post('/printers/UNKNOWN/xreport');
    expect(res.status).toBe(404);
  });

  it('calls runAsync with XReport action', async () => {
    const service = makeService();
    await request(createApp(service)).post('/printers/DT970048/xreport');
    expect(service.runAsync).toHaveBeenCalledOnce();
    expect(service.runAsync.mock.calls[0][0].action).toBe(PrintJobAction.XReport);
  });

  it('returns camelCased ok:true on success', async () => {
    const res = await request(createApp(makeService())).post('/printers/DT970048/xreport');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).not.toHaveProperty('Ok');
  });

  it('returns ok:false when the operation fails', async () => {
    const service = makeService({ runAsync: vi.fn().mockResolvedValue(makeStatus(false)) });
    const res = await request(createApp(service)).post('/printers/DT970048/xreport');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.messages[0].code).toBe('E999');
  });
});

// ── POST /printers/:id/zreport ────────────────────────────────────────────

describe('POST /printers/:id/zreport', () => {
  it('calls runAsync with ZReport action', async () => {
    const service = makeService();
    await request(createApp(service)).post('/printers/DT970048/zreport');
    expect(service.runAsync.mock.calls[0][0].action).toBe(PrintJobAction.ZReport);
  });
});

// ── POST /printers/:id/reset ──────────────────────────────────────────────

describe('POST /printers/:id/reset', () => {
  it('calls runAsync with Reset action', async () => {
    const service = makeService();
    await request(createApp(service)).post('/printers/DT970048/reset');
    expect(service.runAsync.mock.calls[0][0].action).toBe(PrintJobAction.Reset);
  });
});

// ── POST /printers/:id/datetime ───────────────────────────────────────────

describe('POST /printers/:id/datetime', () => {
  it('passes JSON body as the job document', async () => {
    const service = makeService();
    const body = { DeviceDateTime: '2024-01-15T12:00:00' };
    await request(createApp(service))
      .post('/printers/DT970048/datetime')
      .send(body);
    expect(service.runAsync.mock.calls[0][0].action).toBe(PrintJobAction.SetDateTime);
    expect(service.runAsync.mock.calls[0][0].document).toEqual(body);
  });
});

// ── POST /printers/:id/deposit ────────────────────────────────────────────

describe('POST /printers/:id/deposit', () => {
  it('calls runAsync with Deposit action and Amount in document', async () => {
    const service = makeService();
    await request(createApp(service))
      .post('/printers/DT970048/deposit')
      .send({ Amount: 100 });
    const job = service.runAsync.mock.calls[0][0];
    expect(job.action).toBe(PrintJobAction.Deposit);
    expect(job.document.Amount).toBe(100);
  });
});

// ── POST /printers/:id/withdraw ───────────────────────────────────────────

describe('POST /printers/:id/withdraw', () => {
  it('calls runAsync with Withdraw action', async () => {
    const service = makeService();
    await request(createApp(service))
      .post('/printers/DT970048/withdraw')
      .send({ Amount: 50 });
    expect(service.runAsync.mock.calls[0][0].action).toBe(PrintJobAction.Withdraw);
  });
});

// ── POST /printers/:id/receipt ────────────────────────────────────────────

describe('POST /printers/:id/receipt', () => {
  it('calls runAsync with Receipt action', async () => {
    const service = makeService();
    const body = {
      UniqueSaleNumber: 'BG000000-0001-0000001',
      Items: [{ Text: 'Item', UnitPrice: 1.00 }],
      Payments: [{ Amount: 1.00 }],
    };
    await request(createApp(service)).post('/printers/DT970048/receipt').send(body);
    expect(service.runAsync.mock.calls[0][0].action).toBe(PrintJobAction.Receipt);
  });
});

// ── POST /printers/:id/duplicate ─────────────────────────────────────────

describe('POST /printers/:id/duplicate', () => {
  it('calls runAsync with Duplicate action', async () => {
    const service = makeService();
    await request(createApp(service)).post('/printers/DT970048/duplicate');
    expect(service.runAsync.mock.calls[0][0].action).toBe(PrintJobAction.Duplicate);
  });
});

// ── GET /printers/:id/status ──────────────────────────────────────────────

describe('GET /printers/:id/status', () => {
  it('calls printer.checkStatus() and returns result', async () => {
    const fakeStatus = { Ok: true, Messages: [], DeviceDateTime: null };
    const service = makeService({
      printers: { DT970048: { checkStatus: vi.fn().mockResolvedValue(fakeStatus) } },
    });
    const res = await request(createApp(service)).get('/printers/DT970048/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
