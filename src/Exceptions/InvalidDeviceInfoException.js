import { FiscalPrinterException } from './FiscalPrinterException.js';

export class InvalidDeviceInfoException extends FiscalPrinterException {
  constructor(message) {
    super(message || 'Invalid device info');
    this.name = 'InvalidDeviceInfoException';
  }
}
