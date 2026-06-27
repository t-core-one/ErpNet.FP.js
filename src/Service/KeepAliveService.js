'use strict';

const KEEP_ALIVE_INTERVAL_MS = 120 * 1000;

class KeepAliveService {
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
    const printers = this._serviceController.printers;
    for (const [id, printer] of Object.entries(printers)) {
      try {
        await printer.checkStatus();
      } catch (e) {
        console.warn(`KeepAlive check failed for printer ${id}: ${e.message}`);
      }
    }
  }
}

module.exports = { KeepAliveService };
