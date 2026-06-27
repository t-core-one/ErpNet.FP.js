'use strict';

const { FiscalPrinterException } = require('./FiscalPrinterException');

class InvalidDeviceInfoException extends FiscalPrinterException {
  constructor(message) {
    super(message || 'Invalid device info');
    this.name = 'InvalidDeviceInfoException';
  }
}

module.exports = { InvalidDeviceInfoException };
