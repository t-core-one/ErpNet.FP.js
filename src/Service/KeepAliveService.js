import logger from '../logger.js';
import { PrintJob, PrintJobAction } from './PrintJob.js';

const KEEP_ALIVE_INTERVAL_MS = 120 * 1000;

/** Long enough for a Z report to finish ahead of us, short enough to skip a tick. */
const KEEP_ALIVE_TIMEOUT_MS = 60 * 1000;

export class KeepAliveService {
  constructor(serviceController) {
    this._serviceController = serviceController;
    this._timer = null;
    this._failing = new Map();   // printer id -> consecutive failed ticks
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), KEEP_ALIVE_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    if (!this._serviceController.isReady) return;
    for (const [id, printer] of Object.entries(this._serviceController.printers)) {
      try {
        // Go through the job queue rather than touching the port directly. The
        // queue already serialises every other device operation, and calling
        // checkStatus() straight from this timer is what let a keep-alive write
        // to the port while a Z report was mid-read: both replies landed in the
        // channel's single buffer, the parser sliced across the pair, and the Z
        // report's response was destroyed — it returned 200 having never run,
        // and a second Z closed the fiscal day twice.
        const result = await this._serviceController.runAsync(new PrintJob({
          printer,
          action: PrintJobAction.Status,
          document: null,
          asyncTimeout: KEEP_ALIVE_TIMEOUT_MS,
        }));
        this._record(id, this._failureOf(result));
      } catch (e) {
        this._record(id, e.message);
      }
    }
  }

  /** null when the device answered normally, otherwise a description. */
  _failureOf(result) {
    if (!result) return 'no result from the status job';
    if (result.error) return result.error;
    // A job that outran its timeout comes back as a bare { taskId }.
    if (result.taskId && result.Ok === undefined) return 'status check did not complete in time';
    if (result.Ok === false) {
      const messages = (result.Messages || [])
        .filter((m) => m && m.Type === 'error')
        .map((m) => `${m.Code || ''} ${m.Text || ''}`.trim());
      return messages.join('; ') || 'device reported a failure';
    }
    return null;
  }

  /**
   * Say something when the device stops answering.
   *
   * checkStatus() catches every transport failure into a DeviceStatus and
   * returns normally, so this loop used to log NOTHING when the printer was
   * gone — during a 62-minute outage at one shop the only trace was the absence
   * of the two-minute heartbeat, which nothing was watching for. A dead printer
   * has to be loud: it means the till cannot issue a fiscal receipt.
   *
   * Logged on the transition and then at a decaying rate, so an overnight outage
   * does not write hundreds of identical lines while still leaving a trail.
   */
  _record(id, failure) {
    const previous = this._failing.get(id) || 0;

    if (!failure) {
      if (previous > 0) {
        logger.info(`KeepAlive: printer ${id} is answering again after ${previous} failed check(s)`);
      }
      this._failing.delete(id);
      return;
    }

    const count = previous + 1;
    this._failing.set(id, count);
    if (count === 1 || count === 5 || count % 30 === 0) {
      logger.warn(`KeepAlive: printer ${id} not answering (${count} consecutive check(s)): ${failure}`);
    }
  }
}
