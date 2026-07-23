import express from 'express';
import { PrintJob, PrintJobAction, DEFAULT_TIMEOUT } from '../Service/PrintJob.js';
import { parseTimeout } from '../Helpers/Helpers.js';
import { toPascalCase } from '../Helpers/camelCase.js';
import logger from '../logger.js';

const router = express.Router();

// Printer routes query live hardware — never serve stale cached responses.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Normalize incoming JSON bodies to PascalCase so drivers always receive
// PascalCase keys regardless of what the client sends (camelCase or PascalCase).
// This mirrors ASP.NET Core's default case-insensitive JSON binding in the C# server.
router.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') req.body = toPascalCase(req.body);
  next();
});

function getService(req) {
  return req.app.locals.service;
}

function notReady(res) {
  return res.status(405).json({ error: 'Service not ready' });
}

// GET /printers
router.get('/', (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  res.json(service.printersInfo);
});

// GET /printers/:id
router.get('/:id', (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const info = service.printersInfo[req.params.id];
  if (!info) return res.status(404).json({ error: 'Printer not found' });
  res.json(info);
});

// GET /printers/:id/status
router.get('/:id/status', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  try {
    const status = await printer.checkStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /printers/:id/cash
router.get('/:id/cash', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.Cash, document: null,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/rawrequest
router.post('/:id/rawrequest', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.RawRequest, document: req.body,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/receipt
router.post('/:id/receipt', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  logger.debug(`receipt body: ${JSON.stringify(req.body)?.slice(0, 500)}`);
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.Receipt, document: req.body,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/reversalreceipt
router.post('/:id/reversalreceipt', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  logger.debug(`reversalreceipt body: ${JSON.stringify(req.body)?.slice(0, 600)}`);
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.ReversalReceipt, document: req.body,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/withdraw
router.post('/:id/withdraw', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.Withdraw, document: req.body,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/deposit
router.post('/:id/deposit', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.Deposit, document: req.body,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/datetime
router.post('/:id/datetime', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.SetDateTime, document: req.body,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/zreport
router.post('/:id/zreport', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.ZReport, document: null,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/xreport
router.post('/:id/xreport', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.XReport, document: null,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/mreport
router.post('/:id/mreport', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.MReport, document: req.body,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/duplicate
router.post('/:id/duplicate', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.Duplicate, document: null,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/invoice
router.post('/:id/invoice', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  logger.debug(`invoice body: ${JSON.stringify(req.body)?.slice(0, 600)}`);
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.Invoice, document: req.body,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/creditnote
router.post('/:id/creditnote', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  logger.debug(`creditnote body: ${JSON.stringify(req.body)?.slice(0, 600)}`);
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.CreditNote, document: req.body,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /printers/:id/usn
// Reserve a Unique Sale Number (УНП) for a sale. Local, synchronous, offline-safe:
// no fiscal-device I/O and no dependency on the Odoo backend. Idempotent by
// IdempotencyKey (the Odoo order uid) so retries reuse the same number.
router.post('/:id/usn', (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  const info = service.printersInfo[req.params.id];
  if (!printer || !info) return res.status(404).json({ error: 'Printer not found' });
  const serialNumber = (info.SerialNumber || (printer.info && printer.info.SerialNumber) || '');
  const { OperatorCode, IdempotencyKey } = req.body || {};
  try {
    const result = service.reserveUsn({
      serialNumber,
      operatorCode: OperatorCode,
      idempotencyKey: IdempotencyKey,
    });
    res.json({
      UniqueSaleNumber: result.uniqueSaleNumber,
      SequenceNumber: result.sequenceNumber,
      SerialNumber: serialNumber,
      Reused: result.reused,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /printers/:id/usn — read the current counter / init state (monitoring).
router.get('/:id/usn', (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const info = service.printersInfo[req.params.id];
  if (!info) return res.status(404).json({ error: 'Printer not found' });
  const serialNumber = info.SerialNumber || '';
  try {
    res.json(service.getUsnInfo(serialNumber));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /printers/:id/usn/init — initialize (fresh, StartSequence 0) or reseed
// (recovery, StartSequence = high-water mark recovered from Odoo). Destructive,
// so it is gated behind USN_ADMIN_TOKEN when that env var is set.
router.post('/:id/usn/init', (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  const info = service.printersInfo[req.params.id];
  if (!printer || !info) return res.status(404).json({ error: 'Printer not found' });

  const adminToken = process.env.USN_ADMIN_TOKEN;
  if (adminToken && req.get('x-usn-admin-token') !== adminToken) {
    return res.status(401).json({ error: 'Invalid or missing X-USN-Admin-Token' });
  }

  const serialNumber = info.SerialNumber || '';
  const { StartSequence, Force, AllowDecrease } = req.body || {};
  try {
    const result = service.initializeUsn(
      serialNumber,
      StartSequence != null ? StartSequence : 0,
      { force: !!Force, allowDecrease: !!AllowDecrease }
    );
    res.json({ SerialNumber: result.serialNumber, Counter: result.counter });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /printers/:id/reset
router.post('/:id/reset', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = req.query.asyncTimeout !== undefined ? parseInt(req.query.asyncTimeout, 10) : DEFAULT_TIMEOUT;
  const timeout = req.query.timeout ? parseTimeout(req.query.timeout) : 0;
  try {
    const result = await service.runAsync(new PrintJob({
      printer, action: PrintJobAction.Reset, document: null,
      asyncTimeout, timeout, taskId: req.query.taskId,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
