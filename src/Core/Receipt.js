import { Credentials } from './Credentials.js';

export class Receipt extends Credentials {
  constructor() {
    super();
    this.UniqueSaleNumber = '';
    this.Items = [];
    this.Payments = [];
  }
}
