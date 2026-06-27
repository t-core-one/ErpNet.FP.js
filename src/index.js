'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const { ServiceSingleton } = require('./ServiceSingleton');
const { KeepAliveService } = require('./Service/KeepAliveService');
const printersRouter = require('./Routes/printers');
const serviceRouter = require('./Routes/service');

const APP_SETTINGS_FILE = path.join(process.cwd(), 'appsettings.json');

function ensureAppSettings() {
  if (!fs.existsSync(APP_SETTINGS_FILE)) {
    const defaults = {
      'ErpNet.FP': { AutoDetect: true, Printers: {} },
      Server: { Port: 8001 },
    };
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(defaults, null, 2), 'utf8');
  }
}

function loadServerConfig() {
  try {
    const raw = fs.readFileSync(APP_SETTINGS_FILE, 'utf8');
    const json = JSON.parse(raw);
    return json.Server || {};
  } catch (e) {
    return {};
  }
}

async function main() {
  ensureAppSettings();

  const serverConfig = loadServerConfig();
  const port = process.env.PORT || serverConfig.Port || 8001;

  const service = new ServiceSingleton();
  const keepAlive = new KeepAliveService(service);

  const app = express();

  // Middleware
  app.use(express.json({ limit: '500kb' }));
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // CORS for private network access (Chrome 94+)
  const webAccess = service.configOptions.WebAccess || {};
  if (webAccess.EnablePrivateNetwork) {
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Private-Network', 'true');
      next();
    });
  }

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  // Attach service to app locals for route handlers
  app.locals.service = service;

  // Routes — note: taskinfo must be registered before /:id
  app.get('/printers/taskinfo', (req, res) => {
    const info = service.getTaskInfo(req.query.id);
    res.json(info);
  });

  app.use('/printers', printersRouter);
  app.use('/service', serviceRouter);

  // Health check
  app.get('/', (req, res) => {
    res.json({ status: 'ok', version: require('../package.json').version });
  });

  // Start server
  const ssl = serverConfig.Ssl;
  if (ssl && ssl.CertFile && ssl.KeyFile) {
    const tlsOptions = {
      cert: fs.readFileSync(ssl.CertFile),
      key: fs.readFileSync(ssl.KeyFile),
    };
    https.createServer(tlsOptions, app).listen(port, () => {
      console.log(`ErpNet.FP service started on https://0.0.0.0:${port}`);
    });
  } else {
    app.listen(port, () => {
      console.log(`ErpNet.FP service started on http://0.0.0.0:${port}`);
    });
  }

  // Initialize service (detect printers, etc.)
  console.log('Initializing fiscal printer service...');
  service.setup().then(() => {
    console.log(`Service ready. Printers found: ${Object.keys(service.printers).length}`);
    keepAlive.start();
  }).catch(err => {
    console.error('Service setup failed:', err.message);
    // Still mark as ready so admin endpoints work
    service._isReady = true;
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    keepAlive.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    keepAlive.stop();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
