import { ExpiringCache } from '../Helpers/ExpiringCache.js';

export class FiscalPrinterDriver {
  get cache() {
    return FiscalPrinterDriver._cache;
  }

  get driverName() {
    throw new Error('driverName must be implemented');
  }

  connect(channel, serviceOptions, autoDetect = true, options = null) {
    throw new Error('connect must be implemented');
  }
}

FiscalPrinterDriver._cache = new ExpiringCache();
