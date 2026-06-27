export class FiscalPrinterException extends Error {
  constructor(message) {
    super(message || 'Fiscal printer error');
    this.name = 'FiscalPrinterException';
  }
}
