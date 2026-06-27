import { FiscalPrinterException } from './FiscalPrinterException.js';

export class InvalidResponseException extends FiscalPrinterException {
  constructor(message) {
    super(message || 'Invalid response');
    this.name = 'InvalidResponseException';
  }
}
