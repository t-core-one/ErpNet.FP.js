'use strict';

const express = require('express');
const router = express.Router();
const { PrintJob, PrintJobAction, DEFAULT_TIMEOUT } = require('../Service/PrintJob');
const { parseTimeout } = require('../Helpers/Helpers');

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
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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

// GET /printers/taskinfo
router.get('/taskinfo', (req, res) => {
  const service = getService(req);
  const info = service.getTaskInfo(req.query.id);
  res.json(info);
});

// POST /printers/:id/rawrequest
router.post('/:id/rawrequest', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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

// POST /printers/:id/duplicate
router.post('/:id/duplicate', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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

// POST /printers/:id/reset
router.post('/:id/reset', async (req, res) => {
  const service = getService(req);
  if (!service.isReady) return notReady(res);
  const printer = service.printers[req.params.id];
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const asyncTimeout = parseInt(req.query.asyncTimeout, 10) || DEFAULT_TIMEOUT;
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

module.exports = router;
