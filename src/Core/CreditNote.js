import { ReversalReceipt } from './ReversalReceipt.js';

export class CreditNote extends ReversalReceipt {
  constructor() {
    super();
    this.Recipient = null;
    this.Number = '';
    this.Issuer = '';
    this.Receiver = '';
    this.OriginalInvoiceNumber = '';
    this.FiscalDeviceSerialNumber = '';
  }
}
