'use strict';

const { FiscalPrinterException } = require('./FiscalPrinterException');

class StandardizedStatusMessageException extends FiscalPrinterException {
  constructor(code, type, message) {
    super(message || `Standardized status message: [${type}] ${code}`);
    this.name = 'StandardizedStatusMessageException';
    this.code = code;
    this.type = type;
  }
}

module.exports = { StandardizedStatusMessageException };
