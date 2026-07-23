import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';

const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
);
import { Provider } from '../Provider/Provider.js';
import { TaskStatus } from './TaskStatus.js';
import { DEFAULT_TIMEOUT } from './PrintJob.js';
import { ServiceOptions } from '../Configuration/ServiceOptions.js';
import { UsnRegister } from './UsnRegister.js';

// How long a finished task's result is retained so a client that lost the poll
// response can re-issue the SAME taskId and rejoin it instead of re-printing.
// Idempotency depends on this: deleting on first read would let a lost-response
// retry re-run the job and print a duplicate fiscal document.
const TASK_RESULT_TTL_MS = 10 * 60 * 1000;

export class ServiceController {
  constructor(configOptions) {
    this._configOptions = configOptions || new ServiceOptions();
    this._printers = {};
    this._printersInfo = {};
    this._tasks = {};
    this._taskQueue = [];
    this._isReady = false;
    this._isProcessing = false;
    this._provider = null;
    this._usnRegister = null;

    this.serverId = this._ensureServerId();
  }

  get printers() { return this._printers; }
  get printersInfo() { return this._printersInfo; }
  get isReady() { return this._isReady; }
  get configOptions() { return this._configOptions; }

  // Lazily created so services that never reserve a УНП do no disk I/O.
  get usnRegister() {
    if (!this._usnRegister) {
      this._usnRegister = new UsnRegister({ statePath: this._configOptions.UsnStatePath });
    }
    return this._usnRegister;
  }

  // Allocate (or idempotently re-return) a УНП for a sale. Pure local
  // bookkeeping — no hardware I/O — so it succeeds even when the fiscal
  // device is busy and, crucially, when the internet is down.
  reserveUsn({ serialNumber, operatorCode, idempotencyKey }) {
    return this.usnRegister.reserve({ serialNumber, operatorCode, idempotencyKey });
  }

  // Initialize (fresh: startSequence 0) or reseed (recovery: recovered
  // high-water mark) a device's УНП counter. Forward-only unless allowDecrease.
  initializeUsn(serialNumber, startSequence, { force = false, allowDecrease = false } = {}) {
    return this.usnRegister.initializeDevice(serialNumber, startSequence, { force, allowDecrease });
  }

  // Read-only view of a device's counter/initialization state (monitoring).
  getUsnInfo(serialNumber) {
    return {
      serialNumber,
      initialized: this.usnRegister.isDeviceInitialized(serialNumber),
      counter: this.usnRegister.current(serialNumber),
      issuedKeys: this.usnRegister.issuedCount(serialNumber),
      statePath: this.usnRegister.statePath,
    };
  }

  // Reserve (idempotently) the next raw invoice sequence for a sale. Pure local
  // bookkeeping — offline-safe, no device or backend I/O. Odoo formats it into
  // the 10-digit invoice number and records it as account.move.name.
  reserveInvoiceNumber({ serialNumber, idempotencyKey }) {
    return this.usnRegister.reserveInvoiceNumber({ serialNumber, idempotencyKey });
  }

  // Initialize (fresh: 0) or reseed (recovery: recovered high-water mark) the
  // invoice-number counter. Forward-only unless allowDecrease.
  initializeInvoiceNumber(serialNumber, startSequence, { force = false, allowDecrease = false } = {}) {
    return this.usnRegister.initializeInvoiceDevice(serialNumber, startSequence, { force, allowDecrease });
  }

  // Read-only view of a device's invoice-number counter (monitoring).
  getInvoiceNumberInfo(serialNumber) {
    return {
      serialNumber,
      initialized: this.usnRegister.isInvoiceInitialized(serialNumber),
      counter: this.usnRegister.currentInvoice(serialNumber),
      issuedKeys: this.usnRegister.invoiceIssuedCount(serialNumber),
    };
  }

  _ensureServerId() {
    if (this._configOptions.ServerId) return this._configOptions.ServerId;
    const id = uuidv4().replace(/-/g, '').substring(0, 22);
    this._configOptions.ServerId = id;
    return id;
  }

  setupProvider() {
    throw new Error('setupProvider must be implemented');
  }

  async setup() {
    this.setupProvider();

    if (this._configOptions.AutoDetect) {
      await this.detect();
    } else {
      for (const [id, printerConfig] of Object.entries(this._configOptions.Printers || {})) {
        try {
          const printer = await this._provider.connect(printerConfig.Uri);
          if (printer) {
            this._printers[id] = printer;
            this._printersInfo[id] = printer.info;
          }
        } catch (e) {
          logger.error(`Failed to connect configured printer ${id}: ${e.message}`);
        }
      }
    }

    this._isReady = true;
    this._startTaskProcessor();
  }

  async detect() {
    const excludePorts = this._configOptions.ExcludePortList || [];
    try {
      const detected = await this._provider.detectAvailablePrinters(excludePorts);
      for (const [uri, printer] of Object.entries(detected)) {
        const existing = Object.entries(this._printers).find(([, p]) =>
          p.info && p.info.SerialNumber === printer.info.SerialNumber
        );
        if (!existing) {
          const id = printer.info.SerialNumber || uri;
          this._printers[id] = printer;
          this._printersInfo[id] = printer.info;
        }
      }
    } catch (e) {
      logger.error(`Detection failed: ${e.message}`);
    }
    return this._printersInfo;
  }

  getTaskInfo(taskId) {
    this._sweepExpiredTasks();
    const task = this._tasks[taskId];
    if (!task) return { taskStatus: TaskStatus.Unknown, result: null };
    // Do NOT delete a finished task on read: a retry that lost the response must
    // be able to re-issue the same taskId and get this cached result rather than
    // re-run the job (which would print a duplicate). Finished tasks are swept
    // after TASK_RESULT_TTL_MS.
    return { taskStatus: task.status, result: task.result };
  }

  _sweepExpiredTasks() {
    const now = Date.now();
    for (const [id, t] of Object.entries(this._tasks)) {
      if (t.status === TaskStatus.Finished && t.finishedAt && now - t.finishedAt > TASK_RESULT_TTL_MS) {
        delete this._tasks[id];
      }
    }
  }

  async runAsync(printJob) {
    const asyncTimeout = typeof printJob.asyncTimeout === 'number' ? printJob.asyncTimeout : DEFAULT_TIMEOUT;

    if (printJob.taskId) {
      const existing = this._tasks[printJob.taskId];
      if (existing && existing.status === TaskStatus.Finished) {
        return { taskId: printJob.taskId };
      }
    }

    const taskId = printJob.taskId || uuidv4();
    printJob.taskId = taskId;

    this._tasks[taskId] = { status: TaskStatus.Enqueued, result: null };
    this._taskQueue.push(printJob);
    this._processQueue();

    const deadline = Date.now() + asyncTimeout;
    while (Date.now() < deadline) {
      const task = this._tasks[taskId];
      if (task && task.status === TaskStatus.Finished) return task.result;
      await new Promise(r => setTimeout(r, 50));
    }

    if (this._tasks[taskId]) this._tasks[taskId].status = TaskStatus.Timeout;
    return { taskId };
  }

  _startTaskProcessor() {
    this._processQueue();
  }

  async _processQueue() {
    if (this._isProcessing) return;
    this._isProcessing = true;

    while (this._taskQueue.length > 0) {
      const job = this._taskQueue.shift();
      if (!job || !job.taskId) continue;

      const task = this._tasks[job.taskId];
      if (!task) continue;

      task.status = TaskStatus.Running;
      try {
        task.result = await job.run();
      } catch (e) {
        task.result = { error: e.message };
      }
      task.status = TaskStatus.Finished;
      task.finishedAt = Date.now();
    }

    this._isProcessing = false;
  }

  addPrinter(id, printer) {
    this._printers[id] = printer;
    this._printersInfo[id] = printer.info;
    this._writeOptions();
  }

  deletePrinter(id) {
    delete this._printers[id];
    delete this._printersInfo[id];
    if (this._configOptions.Printers) delete this._configOptions.Printers[id];
    this._writeOptions();
  }

  configurePrinter(id, printerConfig) {
    if (!this._configOptions.Printers) this._configOptions.Printers = {};
    this._configOptions.Printers[id] = printerConfig;
    this._writeOptions();
  }

  toggleAutoDetect() {
    this._configOptions.AutoDetect = !this._configOptions.AutoDetect;
    this._writeOptions();
    return this._configOptions.AutoDetect;
  }

  setExcludePorts(ports) {
    this._configOptions.ExcludePortList = ports;
    this._writeOptions();
  }

  setDetectionTimeout(timeout) {
    this._configOptions.DetectionTimeout = timeout;
    this._writeOptions();
  }

  setPrintersProperties(props) {
    this._configOptions.PrintersProperties = props;
    this._writeOptions();
  }

  setWebAccess(webAccess) {
    this._configOptions.WebAccess = webAccess;
    this._writeOptions();
  }

  _writeOptions() {}

  getServerVariables() {
    return {
      version: SERVER_VERSION,
      serverId: this.serverId,
      autoDetect: this._configOptions.AutoDetect,
      udpBeaconPort: this._configOptions.UdpBeaconPort || 0,
      excludePortList: this._configOptions.ExcludePortList || [],
      detectionTimeout: this._configOptions.DetectionTimeout || '30s',
      webAccess: this._configOptions.WebAccess || {},
    };
  }
}
