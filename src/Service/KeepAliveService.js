import logger from '../logger.js';

const KEEP_ALIVE_INTERVAL_MS = 120 * 1000;

export class KeepAliveService {
  constructor(serviceController) {
    this._serviceController = serviceController;
    this._timer = null;
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
        await printer.checkStatus();
      } catch (e) {
        logger.warn(`KeepAlive check failed for printer ${id}: ${e.message}`);
      }
    }
  }
}
