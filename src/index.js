import { readFileSync } from 'fs';
import fs from 'fs';
import path from 'path';

const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);
import https from 'https';
import express from 'express';
import logger from './logger.js';
import { ServiceSingleton } from './ServiceSingleton.js';
import { KeepAliveService } from './Service/KeepAliveService.js';
import printersRouter from './Routes/printers.js';
import serviceRouter from './Routes/service.js';

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

  app.use(express.json({ limit: '500kb' }));
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  const webAccess = service.configOptions.WebAccess || {};
  if (webAccess.EnablePrivateNetwork) {
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Private-Network', 'true');
      next();
    });
  }

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info(`${req.method} ${req.url} ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  app.locals.service = service;

  // taskinfo must be registered before /:id
  app.get('/printers/taskinfo', (req, res) => {
    const info = service.getTaskInfo(req.query.id);
    res.json(info);
  });

  app.use('/printers', printersRouter);
  app.use('/service', serviceRouter);

  app.get('/', (req, res) => {
    res.json({ status: 'ok', version: SERVER_VERSION });
  });

  const ssl = serverConfig.Ssl;
  if (ssl && ssl.CertFile && ssl.KeyFile) {
    const tlsOptions = {
      cert: fs.readFileSync(ssl.CertFile),
      key: fs.readFileSync(ssl.KeyFile),
    };
    https.createServer(tlsOptions, app).listen(port, () => {
      logger.info(`ErpNet.FP service started on https://0.0.0.0:${port}`);
    });
  } else {
    app.listen(port, () => {
      logger.info(`ErpNet.FP service started on http://0.0.0.0:${port}`);
    });
  }

  logger.info('Initializing fiscal printer service...');
  service.setup().then(() => {
    logger.info(`Service ready. Printers found: ${Object.keys(service.printers).length}`);
    keepAlive.start();
  }).catch(err => {
    logger.error(`Service setup failed: ${err.message}`);
    service._isReady = true;
  });

  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    keepAlive.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    keepAlive.stop();
    process.exit(0);
  });
}

main().catch(err => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
