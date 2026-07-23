import fs from 'fs';
import path from 'path';
import logger from '../logger.js';

// УНП (Unique Sale Number) format per Наредба № Н-18/2006, Приложение №29 т.9:
//   <FU serial: 2 letters + 6 digits> - <operator code: 4 alnum> - <7-digit sequence>
// e.g. DT970048-0001-0000001
const SERIAL_REGEX = /^[A-Z]{2}[0-9]{6}$/;
const OPERATOR_REGEX = /^[A-Z0-9]{4}$/;
const MAX_SEQUENCE = 9999999;

// How many recently-issued idempotency keys to remember per device.
// This only guards against retries / client reloads re-requesting the same
// sale — once Odoo has the УНП it caches it locally and syncs it to its own
// (audited) database, so old entries can be safely forgotten.
const MAX_ISSUED_PER_DEVICE = 5000;

function pad7(n) {
  return String(n).padStart(7, '0');
}

/**
 * Durable, per-device authority for УНП allocation.
 *
 * The print server is the natural single writer for a fiscal device's sale
 * sequence: exactly one device is bound per serial, and the counter never has
 * to be coordinated across machines. Because the counter is persisted
 * write-through to disk, УНП numbers survive a service restart — a naive
 * in-memory counter would repeat numbers after a reboot, producing duplicate
 * УНП, which is a hard compliance violation.
 *
 * Allocation is idempotent: re-reserving with the same idempotencyKey (the
 * Odoo order uid) returns the number already issued for that sale, so retries
 * and client reloads never burn or duplicate a number.
 */
export class UsnRegister {
  constructor(options = {}) {
    this._statePath = options.statePath || path.join(process.cwd(), 'usn-state.json');
    this._maxIssuedPerDevice = options.maxIssuedPerDevice || MAX_ISSUED_PER_DEVICE;
    this._state = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this._statePath, 'utf8');
      const json = JSON.parse(raw);
      if (json && typeof json === 'object' && json.devices && typeof json.devices === 'object') {
        return json;
      }
      logger.warn(`УНП state file ${this._statePath} malformed; starting fresh`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // A corrupt state file must NOT be silently discarded — that would
        // reset the counter and repeat numbers. Fail loud and refuse to start
        // fresh over an existing-but-unreadable file.
        if (fs.existsSync(this._statePath)) {
          throw new Error(`Refusing to start: УНП state file ${this._statePath} is unreadable (${e.message}). Fix or remove it manually to avoid duplicate sale numbers.`);
        }
      }
    }
    return { devices: {} };
  }

  _persist() {
    // Atomic write: write to a temp file then rename, so a crash mid-write
    // never leaves a truncated (counter-losing) state file.
    const tmp = `${this._statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), 'utf8');
    fs.renameSync(tmp, this._statePath);
  }

  _device(serialNumber) {
    let dev = this._state.devices[serialNumber];
    if (!dev) {
      dev = { counter: 0, issued: {}, order: [] };
      this._state.devices[serialNumber] = dev;
    }
    // Defensive: tolerate a hand-edited / older state shape.
    if (typeof dev.counter !== 'number') dev.counter = 0;
    if (!dev.issued || typeof dev.issued !== 'object') dev.issued = {};
    if (!Array.isArray(dev.order)) dev.order = Object.keys(dev.issued);
    return dev;
  }

  _prune(dev) {
    while (dev.order.length > this._maxIssuedPerDevice) {
      const oldest = dev.order.shift();
      delete dev.issued[oldest];
    }
  }

  /**
   * Reserve (or re-return) a УНП for a sale.
   *
   * Synchronous by design — no await inside the allocation, so Node's single
   * thread guarantees no two callers can be handed the same counter value.
   *
   * @param {object} p
   * @param {string} p.serialNumber   device serial (2 letters + 6 digits)
   * @param {string} p.operatorCode   4-char operator code (res.users.ref)
   * @param {string} p.idempotencyKey stable per-sale key (Odoo order uid)
   * @returns {{ uniqueSaleNumber: string, sequenceNumber: number, reused: boolean }}
   */
  reserve({ serialNumber, operatorCode, idempotencyKey } = {}) {
    const serial = String(serialNumber || '').trim().toUpperCase();
    if (!SERIAL_REGEX.test(serial)) {
      throw new Error(`Invalid device serial "${serialNumber}" for УНП (expected 2 letters + 6 digits)`);
    }
    const operator = String(operatorCode || '').trim().toUpperCase();
    if (!OPERATOR_REGEX.test(operator)) {
      throw new Error(`Invalid operator code "${operatorCode}" for УНП (expected 4 alphanumeric chars)`);
    }
    const key = String(idempotencyKey || '').trim();
    if (!key) {
      throw new Error('idempotencyKey is required for УНП reservation');
    }

    const dev = this._device(serial);

    // Idempotent: same sale, same number. Note the operator is intentionally
    // NOT part of the key — a re-reservation returns the originally issued
    // number even if the operator later changes, preserving the 1:1 sale↔УНП.
    const existing = dev.issued[key];
    if (existing) {
      return { uniqueSaleNumber: existing, sequenceNumber: existing, reused: true };
    }

    if (dev.counter >= MAX_SEQUENCE) {
      throw new Error(`УНП sequence exhausted for device ${serial} (reached ${MAX_SEQUENCE})`);
    }

    dev.counter += 1;
    const seq = dev.counter;
    const usn = `${serial}-${operator}-${pad7(seq)}`;

    dev.issued[key] = usn;
    dev.order.push(key);
    this._prune(dev);
    this._persist();

    logger.info(`Reserved УНП ${usn} for device ${serial} (key=${key})`);
    return { uniqueSaleNumber: usn, sequenceNumber: seq, reused: false };
  }

  /** Current sequence value for a device (0 if none issued yet). Read-only. */
  current(serialNumber) {
    const serial = String(serialNumber || '').trim().toUpperCase();
    const dev = this._state.devices[serial];
    return dev ? dev.counter : 0;
  }
}
