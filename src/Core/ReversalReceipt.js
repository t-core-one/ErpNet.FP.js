import { Receipt } from './Receipt.js';

export const ReversalReason = Object.freeze({
  OperatorError: 'operator-error',
  Refund: 'refund',
  TaxBaseReduction: 'tax-base-reduction',
});

export class ReversalReceipt extends Receipt {
  constructor() {
    super();
    this.ReceiptNumber = '';
    this.ReceiptDateTime = null;
    this.FiscalMemorySerialNumber = '';
    this.Reason = ReversalReason.OperatorError;
  }

  cloneReceipt(receipt) {
    this.Operator = receipt.Operator;
    this.OperatorPassword = receipt.OperatorPassword;
    this.UniqueSaleNumber = receipt.UniqueSaleNumber;
    this.Items = receipt.Items ? receipt.Items.slice() : [];
    this.Payments = receipt.Payments ? receipt.Payments.slice() : [];
  }
}
