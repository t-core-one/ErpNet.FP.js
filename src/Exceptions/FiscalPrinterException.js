'use strict';

class FiscalPrinterException extends Error {
  constructor(message) {
    super(message || 'Fiscal printer error');
    this.name = 'FiscalPrinterException';
  }
}

module.exports = { FiscalPrinterException };
