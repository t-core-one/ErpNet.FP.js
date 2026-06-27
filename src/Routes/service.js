import express from 'express';

const router = express.Router();

function getService(req) {
  return req.app.locals.service;
}

// GET /service/vars
router.get('/vars', (req, res) => {
  const service = getService(req);
  res.json(service.getServerVariables());
});

// GET /service/toggleautodetect
router.get('/toggleautodetect', (req, res) => {
  const service = getService(req);
  const newValue = service.toggleAutoDetect();
  res.json({ autoDetect: newValue });
});

// POST /service/excludeports
router.post('/excludeports', (req, res) => {
  const service = getService(req);
  const ports = req.body;
  service.setExcludePorts(Array.isArray(ports) ? ports : []);
  res.json({ excludePortList: service.configOptions.ExcludePortList });
});

// POST /service/detectiontimeout
router.post('/detectiontimeout', (req, res) => {
  const service = getService(req);
  const timeout = req.body && req.body.timeout ? req.body.timeout : (typeof req.body === 'string' ? req.body : '30s');
  service.setDetectionTimeout(timeout);
  res.json({ detectionTimeout: service.configOptions.DetectionTimeout });
});

// GET /service/detect
router.get('/detect', async (req, res) => {
  const service = getService(req);
  try {
    const result = await service.detect();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /service/stop
router.get('/stop', (req, res) => {
  res.json({ stopped: true });
  process.nextTick(() => process.exit(0));
});

// GET /service/printersprops
router.get('/printersprops', (req, res) => {
  const service = getService(req);
  res.json(service.configOptions.PrintersProperties || {});
});

// POST /service/printersprops
router.post('/printersprops', (req, res) => {
  const service = getService(req);
  service.setPrintersProperties(req.body || {});
  res.json(service.configOptions.PrintersProperties);
});

// POST /service/webaccess
router.post('/webaccess', (req, res) => {
  const service = getService(req);
  service.setWebAccess(req.body || {});
  res.json(service.configOptions.WebAccess);
});

// GET /service/printers
router.get('/printers', (req, res) => {
  const service = getService(req);
  res.json(service.configOptions.Printers || {});
});

// POST /service/printers/configure
router.post('/printers/configure', (req, res) => {
  const service = getService(req);
  const { id, uri } = req.body || {};
  if (!id || !uri) return res.status(400).json({ error: 'id and uri are required' });
  service.configurePrinter(id, { Uri: uri });
  res.json({ id, uri });
});

// POST /service/printers/delete
router.post('/printers/delete', (req, res) => {
  const service = getService(req);
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id is required' });
  service.deletePrinter(id);
  res.json({ deleted: id });
});

export default router;
