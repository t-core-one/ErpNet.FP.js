import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import serviceRouter from '../../src/Routes/service.js';
import { toCamelCase } from '../../src/Helpers/camelCase.js';

function createApp(mockService) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const orig = res.json.bind(res);
    res.json = (data) => orig(toCamelCase(data));
    next();
  });
  app.locals.service = mockService;
  app.use('/service', serviceRouter);
  return app;
}

// ── GET /service/vars ─────────────────────────────────────────────────────

describe('GET /service/vars', () => {
  it('returns server variables', async () => {
    const vars = { version: '1.0.0', serverId: 'abc123', autoDetect: true, excludePortList: [] };
    const app = createApp({ getServerVariables: () => vars });
    const res = await request(app).get('/service/vars');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.0.0');
    expect(res.body.serverId).toBe('abc123');
    expect(res.body.autoDetect).toBe(true);
  });
});

// ── GET /service/detect ───────────────────────────────────────────────────

describe('GET /service/detect', () => {
  it('calls service.detect() and returns printers info', async () => {
    const printerInfo = { DT970048: { SerialNumber: 'DT970048' } };
    const service = { detect: vi.fn().mockResolvedValue(printerInfo) };
    const app = createApp(service);
    const res = await request(app).get('/service/detect');
    expect(res.status).toBe(200);
    expect(service.detect).toHaveBeenCalledOnce();
    expect(res.body).toHaveProperty('DT970048');
    // Serial number key must be preserved by toCamelCase
    expect(res.body).not.toHaveProperty('dT970048');
  });

  it('returns 500 on detection error', async () => {
    const service = { detect: vi.fn().mockRejectedValue(new Error('port busy')) };
    const app = createApp(service);
    const res = await request(app).get('/service/detect');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('port busy');
  });
});

// ── GET /service/toggleautodetect ─────────────────────────────────────────

describe('GET /service/toggleautodetect', () => {
  it('returns the new autoDetect value', async () => {
    const service = { toggleAutoDetect: vi.fn().mockReturnValue(false) };
    const res = await request(createApp(service)).get('/service/toggleautodetect');
    expect(res.status).toBe(200);
    expect(res.body.autoDetect).toBe(false);
    expect(service.toggleAutoDetect).toHaveBeenCalledOnce();
  });
});

// ── POST /service/excludeports ────────────────────────────────────────────

describe('POST /service/excludeports', () => {
  it('calls setExcludePorts with the given array', async () => {
    const service = {
      setExcludePorts: vi.fn(),
      configOptions: { ExcludePortList: ['/dev/ttyS0'] },
    };
    const res = await request(createApp(service))
      .post('/service/excludeports')
      .send(['/dev/ttyS0']);
    expect(res.status).toBe(200);
    expect(service.setExcludePorts).toHaveBeenCalledWith(['/dev/ttyS0']);
  });

  it('wraps non-array body in an array', async () => {
    const service = {
      setExcludePorts: vi.fn(),
      configOptions: { ExcludePortList: [] },
    };
    await request(createApp(service)).post('/service/excludeports').send('/dev/ttyS0');
    expect(service.setExcludePorts).toHaveBeenCalledWith([]);
  });
});

// ── GET /service/printersprops ────────────────────────────────────────────

describe('GET /service/printersprops', () => {
  it('returns printers properties from configOptions', async () => {
    const app = createApp({ configOptions: { PrintersProperties: { DT970048: { uri: 'x' } } } });
    const res = await request(app).get('/service/printersprops');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('DT970048');
  });
});

// ── POST /service/printers/configure ─────────────────────────────────────

describe('POST /service/printers/configure', () => {
  it('returns 400 when id is missing', async () => {
    const app = createApp({ configurePrinter: vi.fn() });
    const res = await request(app).post('/service/printers/configure').send({ uri: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when uri is missing', async () => {
    const app = createApp({ configurePrinter: vi.fn() });
    const res = await request(app).post('/service/printers/configure').send({ id: 'DT970048' });
    expect(res.status).toBe(400);
  });

  it('calls configurePrinter and returns id+uri', async () => {
    const service = { configurePrinter: vi.fn() };
    const res = await request(createApp(service))
      .post('/service/printers/configure')
      .send({ id: 'DT970048', uri: 'bg.dt.p.isl:///dev/ttyACM1' });
    expect(res.status).toBe(200);
    expect(service.configurePrinter).toHaveBeenCalledWith('DT970048', { Uri: 'bg.dt.p.isl:///dev/ttyACM1' });
    expect(res.body).toMatchObject({ id: 'DT970048', uri: 'bg.dt.p.isl:///dev/ttyACM1' });
  });
});

// ── POST /service/printers/delete ─────────────────────────────────────────

describe('POST /service/printers/delete', () => {
  it('returns 400 when id is missing', async () => {
    const app = createApp({ deletePrinter: vi.fn() });
    const res = await request(app).post('/service/printers/delete').send({});
    expect(res.status).toBe(400);
  });

  it('calls deletePrinter and returns the deleted id', async () => {
    const service = { deletePrinter: vi.fn() };
    const res = await request(createApp(service))
      .post('/service/printers/delete')
      .send({ id: 'DT970048' });
    expect(res.status).toBe(200);
    expect(service.deletePrinter).toHaveBeenCalledWith('DT970048');
    expect(res.body.deleted).toBe('DT970048');
  });
});

// ── POST /service/webaccess ───────────────────────────────────────────────

describe('POST /service/webaccess', () => {
  it('calls setWebAccess with the body', async () => {
    const service = {
      setWebAccess: vi.fn(),
      configOptions: { WebAccess: { EnablePrivateNetwork: true } },
    };
    const body = { EnablePrivateNetwork: true };
    const res = await request(createApp(service)).post('/service/webaccess').send(body);
    expect(res.status).toBe(200);
    expect(service.setWebAccess).toHaveBeenCalledWith(body);
  });
});
