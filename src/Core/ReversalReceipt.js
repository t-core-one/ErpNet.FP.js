'use strict';

const { Receipt } = require('./Receipt');

const ReversalReason = Object.freeze({
  OperatorError: 1,
  Refund: 2,
  TaxBaseReduction: 3,
});

class ReversalReceipt extends Receipt {
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

module.exports = { ReversalReason, ReversalReceipt };
