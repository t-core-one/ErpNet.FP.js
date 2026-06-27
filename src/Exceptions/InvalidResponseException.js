'use strict';

const { FiscalPrinterException } = require('./FiscalPrinterException');

class InvalidResponseException extends FiscalPrinterException {
  constructor(message) {
    super(message || 'Invalid response');
    this.name = 'InvalidResponseException';
  }
}

module.exports = { InvalidResponseException };
