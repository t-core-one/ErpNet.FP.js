'use strict';

const { ExpiringCache } = require('../Helpers/ExpiringCache');

class FiscalPrinterDriver {
  constructor() {
    if (!FiscalPrinterDriver._cache) {
      FiscalPrinterDriver._cache = new ExpiringCache();
    }
  }

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

module.exports = { FiscalPrinterDriver };
