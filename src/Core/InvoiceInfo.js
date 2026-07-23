import { ReceiptInfo } from './ReceiptInfo.js';

export class InvoiceInfo extends ReceiptInfo {
  constructor() {
    super();
    this.InvoiceNumber = '';
  }
}
