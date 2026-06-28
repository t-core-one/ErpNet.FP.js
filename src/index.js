import { readFileSync } from 'fs';
import fs from 'fs';
import path from 'path';
import https from 'https';
import express from 'express';
import logger from './logger.js';
import { ServiceSingleton } from './ServiceSingleton.js';
import { KeepAliveService } from './Service/KeepAliveService.js';
import printersRouter from './Routes/printers.js';
import serviceRouter from './Routes/service.js';

const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

const WWWROOT = new URL('../wwwroot', import.meta.url).pathname;
const LOGS_DIR = path.join(process.cwd(), 'logs');
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

import { toCamelCase } from './Helpers/camelCase.js';

async function main() {
  ensureAppSettings();

  const serverConfig = loadServerConfig();
  const port = process.env.PORT || serverConfig.Port || 8001;

  const service = new ServiceSingleton();
  const keepAlive = new KeepAliveService(service);

  const app = express();

  // Disable ETag generation for all API responses.
  // express.static has its own etag option and is unaffected.
  // This prevents 304 responses for live hardware endpoints even when
  // the browser sends a cached If-None-Match header.
  app.set('etag', false);

  app.use(express.json({ limit: '500kb' }));
  app.use(express.urlencoded({ extended: false, limit: '500kb' }));

  // Convert PascalCase response keys to camelCase (matching C# ASP.NET default serializer)
  app.use((req, res, next) => {
    const orig = res.json.bind(res);
    res.json = (data) => orig(toCamelCase(data));
    next();
  });
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
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  app.locals.service = service;

  // API routes — taskinfo must be registered before /:id
  app.get('/printers/taskinfo', (req, res) => {
    const info = service.getTaskInfo(req.query.id);
    res.json(info);
  });
  app.use('/printers', printersRouter);
  app.use('/service', serviceRouter);

  // Debug log browser
  app.get('/debug', (req, res) => {
    fs.readdir(LOGS_DIR, (err, files) => {
      if (err) return res.status(404).send('No logs directory');
      const links = (files || [])
        .filter(f => f.endsWith('.log') || f.endsWith('.log.gz'))
        .sort()
        .reverse()
        .map(f => `<li><a href="/debug/${encodeURIComponent(f)}">${f}</a></li>`)
        .join('');
      res.type('html').send(`<!doctype html><html><body><h2>Debug logs</h2><ul>${links}</ul></body></html>`);
    });
  });
  app.get('/debug/:file', (req, res) => {
    const filePath = path.join(LOGS_DIR, path.basename(req.params.file));
    if (!filePath.startsWith(LOGS_DIR)) return res.status(403).end();
    res.type('text/plain; charset=utf-8').sendFile(filePath);
  });

  // Admin UI — static files from wwwroot/
  app.use(express.static(WWWROOT));

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
