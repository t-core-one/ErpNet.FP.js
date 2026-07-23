import { Receipt } from './Receipt.js';

export class Invoice extends Receipt {
  constructor() {
    super();
    this.Recipient = null;
    this.Number = '';
    this.Issuer = '';
    this.Receiver = '';
  }
}
