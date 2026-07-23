import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../logger.js';

// УНП (Unique Sale Number) format per Наредба № Н-18/2006, Приложение №29 т.9:
//   <FU serial: 2 letters + 6 digits> - <operator code: 4 alnum> - <7-digit sequence>
// e.g. DT970048-0001-0000001
const SERIAL_REGEX = /^[A-Z]{2}[0-9]{6}$/;
const OPERATOR_REGEX = /^[A-Z0-9]{4}$/;
const MAX_SEQUENCE = 9999999;
const STATE_VERSION = 2;

// How many recently-issued idempotency keys to remember per device (retry/reload
// guard; Odoo caches the УНП and syncs it, so old keys can be forgotten).
const MAX_ISSUED_PER_DEVICE = 5000;

function pad7(n) {
  return String(n).padStart(7, '0');
}

// Where the durable counter lives. Deliberately OUTSIDE the app/deploy dir so a
// git pull, container rebuild or `npm ci` cannot wipe it. Precedence:
// explicit config (UsnStatePath) > USN_STATE_PATH env > ~/.erpnet-fp/.
function defaultStatePath() {
  if (process.env.USN_STATE_PATH) return process.env.USN_STATE_PATH;
  let home = null;
  try {
    home = os.homedir();
  } catch (_) {
    home = null;
  }
  const dir = home ? path.join(home, '.erpnet-fp') : path.join(process.cwd(), '.erpnet-fp');
  return path.join(dir, 'usn-state.json');
}

/**
 * Durable, per-device authority for УНП allocation.
 *
 * The print server is the natural single writer for a fiscal device's sale
 * sequence: exactly one device is bound per serial, so the counter never needs
 * cross-machine coordination.
 *
 * Safety model (fail-closed): a duplicate/reused УНП is a hard compliance
 * violation, so the register NEVER invents a starting number. A device may mint
 * only after it has been explicitly initialized — with 0 for a brand-new device,
 * or with the high-water mark recovered from Odoo after a state loss. If the
 * state file is missing (deleted/wiped) a device is simply "not initialized" and
 * minting is refused until reseeded; if the file is present but corrupt the
 * whole register refuses to start. Either way the counter is never silently
 * reset to 0. The counter is persisted write-through (atomic temp+rename, plus a
 * `.bak` snapshot) so an in-flight write can never lose or repeat a number.
 *
 * Allocation is idempotent by a client-supplied key (the Odoo order uid), so
 * retries and client reloads never burn or duplicate a number.
 */
export class UsnRegister {
  constructor(options = {}) {
    this._statePath = options.statePath || defaultStatePath();
    this._maxIssuedPerDevice = options.maxIssuedPerDevice || MAX_ISSUED_PER_DEVICE;
    this._state = this._load();
  }

  get statePath() {
    return this._statePath;
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this._statePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        // No state file: either a brand-new install or the file was lost. We
        // cannot tell those apart from the filesystem alone, so we do NOT invent
        // a starting number — every device stays "not initialized" and minting
        // is refused (fail-closed) until initialized/reseeded explicitly.
        logger.warn(
          `УНП state file ${this._statePath} not found. Devices must be initialized ` +
          `(0 for new, or the high-water mark recovered from Odoo) before minting.`
        );
        return { version: STATE_VERSION, devices: {} };
      }
      // Present but unreadable (permissions, I/O error) — fail closed.
      throw new Error(
        `Refusing to start: УНП state file ${this._statePath} is unreadable (${e.message}). ` +
        `Restore it (a .bak sits next to it) or reseed from the УНП recorded in Odoo.`
      );
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      // Present but corrupt — fail closed rather than silently resetting to 0.
      throw new Error(
        `Refusing to start: УНП state file ${this._statePath} is corrupt (${e.message}). ` +
        `Restore it (a .bak sits next to it) or reseed from the УНП recorded in Odoo.`
      );
    }
    if (!json || typeof json !== 'object' || !json.devices || typeof json.devices !== 'object') {
      // Valid JSON but wrong shape — treat like corruption (do NOT reset).
      throw new Error(
        `Refusing to start: УНП state file ${this._statePath} has an unexpected shape. ` +
        `Restore it or reseed from the УНП recorded in Odoo.`
      );
    }
    if (!json.version) json.version = STATE_VERSION;
    return json;
  }

  _persist() {
    const dir = path.dirname(this._statePath);
    fs.mkdirSync(dir, { recursive: true });
    // Keep a forensic snapshot of the prior good state before overwriting, so a
    // human can inspect/recover after damage. It is NOT auto-trusted: recovery
    // always goes through an explicit reseed (see initializeDevice).
    try {
      if (fs.existsSync(this._statePath)) {
        fs.copyFileSync(this._statePath, `${this._statePath}.bak`);
      }
    } catch (e) {
      logger.warn(`Could not write УНП state backup: ${e.message}`);
    }
    // Durable atomic write: write temp → fsync the file → rename (atomic) →
    // fsync the directory. rename alone gives atomicity but NOT durability; on
    // a power loss (e.g. the RPi's SD card) an un-fsync'd write can roll back to
    // stale content, and a later _load would resume from a lower counter and
    // re-issue already-printed numbers. fsync closes that window.
    const tmp = `${this._statePath}.tmp`;
    const data = JSON.stringify(this._state, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this._statePath);
    // Make the rename (a directory metadata change) durable too.
    try {
      const dfd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch (e) {
      // Directory fsync is unsupported on some platforms/filesystems; the file
      // fsync above already covers the common power-loss case.
      logger.warn(`Could not fsync УНП state directory: ${e.message}`);
    }
  }

  _existingDevice(serial) {
    const dev = this._state.devices[serial];
    if (!dev) return null;
    // Defensive: tolerate a hand-edited / older state shape.
    if (typeof dev.counter !== 'number') dev.counter = 0;
    if (!dev.issued || typeof dev.issued !== 'object') dev.issued = {};
    if (!Array.isArray(dev.order)) dev.order = Object.keys(dev.issued);
    return dev;
  }

  isDeviceInitialized(serialNumber) {
    const serial = String(serialNumber || '').trim().toUpperCase();
    return !!this._state.devices[serial];
  }

  /**
   * Initialize or reseed a device's counter.
   *  - Fresh install: startSequence = 0.
   *  - Recovery after state loss: startSequence = high-water mark recovered
   *    from Odoo + a safety margin (to jump past any in-flight/offline/abandoned
   *    numbers; the resulting gap is legal under Н-18).
   *
   * Initializing a device that already has state requires `force`, so a counter
   * is never clobbered by accident. Lowering a counter is allowed only with
   * force and is logged loudly (it can repeat numbers).
   */
  initializeDevice(serialNumber, startSequence = 0, { force = false, allowDecrease = false } = {}) {
    const serial = String(serialNumber || '').trim().toUpperCase();
    if (!SERIAL_REGEX.test(serial)) {
      throw new Error(`Invalid device serial "${serialNumber}" (expected 2 letters + 6 digits)`);
    }
    const start = Number(startSequence);
    if (!Number.isInteger(start) || start < 0 || start > MAX_SEQUENCE) {
      throw new Error(`Invalid startSequence ${startSequence} (expected integer 0..${MAX_SEQUENCE})`);
    }
    const existing = this._existingDevice(serial);
    if (existing && !force) {
      throw new Error(
        `Device ${serial} is already initialized (counter=${existing.counter}). ` +
        `Pass force=true to reseed (recovery).`
      );
    }
    // Forward-only by default: refuse to lower a counter (that repeats numbers)
    // unless the caller explicitly asserts allowDecrease.
    if (existing && start < existing.counter && !allowDecrease) {
      throw new Error(
        `Refusing to reseed device ${serial} to a LOWER counter (${existing.counter} -> ${start}); ` +
        `this would repeat already-issued numbers. Reseed forward (>= current), or pass ` +
        `allowDecrease=true only if you are certain.`
      );
    }
    if (existing && start < existing.counter) {
      logger.warn(
        `Reseeding device ${serial} to a LOWER counter (${existing.counter} -> ${start}); ` +
        `this can repeat previously issued numbers.`
      );
    }
    const prevCounter = existing ? existing.counter : null;
    const dev = existing || { counter: 0, issued: {}, order: [] };
    dev.counter = start;
    this._state.devices[serial] = dev;
    try {
      this._persist();
    } catch (e) {
      // Roll back so in-memory state matches disk; a retry re-attempts cleanly.
      if (existing) {
        existing.counter = prevCounter;
      } else {
        delete this._state.devices[serial];
      }
      throw e;
    }
    logger.info(
      `Initialized УНП device ${serial} at counter ${start}${force ? ' (force/reseed)' : ''}`
    );
    return { serialNumber: serial, counter: dev.counter };
  }

  /**
   * Reserve (or idempotently re-return) a УНП for a sale.
   *
   * Synchronous by design — there is no await between reading and writing the
   * counter, so Node's single thread guarantees two callers can never be handed
   * the same value, and the number is persisted before this returns.
   *
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

    // FAIL-CLOSED: never invent a starting number. A missing device entry means
    // either a new device or a lost state file — in both cases refuse until an
    // explicit init/reseed supplies the correct starting sequence.
    const dev = this._existingDevice(serial);
    if (!dev) {
      throw new Error(
        `УНП is not initialized for device ${serial}. Initialize it (0 for a new device, ` +
        `or the high-water mark recovered from Odoo) before minting. This guard prevents ` +
        `duplicate УНП after a lost state file.`
      );
    }

    // Idempotent: same sale, same number. The operator is intentionally NOT part
    // of the key — a re-reservation returns the originally issued number even if
    // the operator later changes, preserving the 1:1 sale↔УНП.
    const existing = dev.issued[key];
    if (existing) {
      const seq = parseInt(existing.split('-').pop(), 10);
      return { uniqueSaleNumber: existing, sequenceNumber: seq, reused: true };
    }

    if (dev.counter >= MAX_SEQUENCE) {
      throw new Error(`УНП sequence exhausted for device ${serial} (reached ${MAX_SEQUENCE})`);
    }

    const seq = dev.counter + 1;
    const usn = `${serial}-${operator}-${pad7(seq)}`;

    // Commit in memory, then persist. If the durable write fails, roll the
    // mutation back so we never hand out (and then, on the idempotent retry,
    // re-hand-out) a number that was never written to disk.
    dev.counter = seq;
    dev.issued[key] = usn;
    dev.order.push(key);
    try {
      this._persist();
    } catch (e) {
      dev.counter = seq - 1;
      delete dev.issued[key];
      dev.order.pop();
      throw e;
    }
    // Memory-only bookkeeping; persisted on the next successful write.
    this._prune(dev);

    if (seq >= MAX_SEQUENCE * 0.99) {
      logger.warn(
        `УНП sequence for device ${serial} is near exhaustion (${seq}/${MAX_SEQUENCE}). ` +
        `Plan a device swap / sequence reset.`
      );
    }
    logger.info(`Reserved УНП ${usn} for device ${serial} (key=${key})`);
    return { uniqueSaleNumber: usn, sequenceNumber: seq, reused: false };
  }

  _prune(dev) {
    while (dev.order.length > this._maxIssuedPerDevice) {
      const oldest = dev.order.shift();
      delete dev.issued[oldest];
    }
  }

  /** Current sequence value for a device (0 if none/uninitialized). Read-only. */
  current(serialNumber) {
    const serial = String(serialNumber || '').trim().toUpperCase();
    const dev = this._state.devices[serial];
    return dev ? dev.counter : 0;
  }
}
