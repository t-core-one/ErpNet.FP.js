import iconv from 'iconv-lite';
import { DeviceInfo } from '../Core/DeviceInfo.js';
import { DeviceStatusWithReceiptInfo } from '../Core/DeviceStatus.js';
import { PaymentType } from '../Core/Payment.js';
import { ItemType, PriceModifierType } from '../Core/Item.js';
import { ReversalReason } from '../Core/ReversalReceipt.js';

const USN_REGEX = /^[A-Z]{2}[0-9]{6}-[A-Z0-9]{4}-[0-9]{7}$/;

export class BgFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    this._channel = channel;
    this._serviceOptions = serviceOptions;
    this._options = options || {};
    this.info = new DeviceInfo();
    this.encoding = 'cp1251';

    this.paymentTypeMappings = {
      [PaymentType.Cash]: '0',
      [PaymentType.Check]: '1',
      [PaymentType.Coupons]: '2',
      [PaymentType.ExtCoupons]: '3',
      [PaymentType.Packaging]: '4',
      [PaymentType.InternalUsage]: '5',
      [PaymentType.Damage]: '6',
      [PaymentType.Card]: '7',
      [PaymentType.Bank]: '8',
      [PaymentType.Reserved1]: '9',
      [PaymentType.Reserved2]: '10',
    };
  }

  encodeString(str) {
    return iconv.encode(str || '', this.encoding);
  }

  decodeBuffer(buf) {
    return iconv.decode(buf, this.encoding);
  }

  getPaymentTypeText(paymentType) {
    return this.paymentTypeMappings[paymentType] || '0';
  }

  getReversalReasonText(reason) {
    switch (reason) {
      case ReversalReason.OperatorError: return '0';
      case ReversalReason.Refund: return '1';
      case ReversalReason.TaxBaseReduction: return '2';
      default: return '0';
    }
  }

  getTaxGroupText(taxGroup) {
    throw new Error('getTaxGroupText must be implemented');
  }

  getSupportedPaymentTypes() {
    return Object.keys(this.paymentTypeMappings)
      .map(k => parseInt(k, 10))
      .filter(k => k !== PaymentType.Change);
  }

  validateReceipt(receipt) {
    const status = new DeviceStatusWithReceiptInfo();
    if (!receipt) {
      status.addError('E101', 'Receipt is required');
      return status;
    }
    if (!receipt.UniqueSaleNumber || !USN_REGEX.test(receipt.UniqueSaleNumber)) {
      status.addError('E102', `Invalid UniqueSaleNumber: ${receipt.UniqueSaleNumber}`);
    }
    if (!receipt.Items || receipt.Items.length === 0) {
      status.addError('E103', 'Receipt must have at least one item');
    }
    if (!receipt.Payments || receipt.Payments.length === 0) {
      status.addError('E104', 'Receipt must have at least one payment');
    }
    return status;
  }

  validateReversalReceipt(reversalReceipt) {
    const status = new DeviceStatusWithReceiptInfo();
    if (!reversalReceipt) {
      status.addError('E201', 'ReversalReceipt is required');
      return status;
    }
    if (!reversalReceipt.UniqueSaleNumber || !USN_REGEX.test(reversalReceipt.UniqueSaleNumber)) {
      status.addError('E202', `Invalid UniqueSaleNumber: ${reversalReceipt.UniqueSaleNumber}`);
    }
    return status;
  }

  validateTransferAmount(transferAmount) {
    const status = new DeviceStatusWithReceiptInfo();
    if (!transferAmount) {
      status.addError('E301', 'TransferAmount is required');
      return status;
    }
    if (typeof transferAmount.Amount !== 'number' || isNaN(transferAmount.Amount)) {
      status.addError('E302', 'Amount must be a number');
    }
    return status;
  }

  setDeadLine(deadLine) {}

  checkStatus() { throw new Error('checkStatus must be implemented'); }
  cash() { throw new Error('cash must be implemented'); }
  setDateTime(datetime) { throw new Error('setDateTime must be implemented'); }
  printReceipt(receipt) { throw new Error('printReceipt must be implemented'); }
  printReversalReceipt(reversalReceipt) { throw new Error('printReversalReceipt must be implemented'); }
  printMoneyDeposit(transferAmount) { throw new Error('printMoneyDeposit must be implemented'); }
  printMoneyWithdraw(transferAmount) { throw new Error('printMoneyWithdraw must be implemented'); }
  printZReport(credentials) { throw new Error('printZReport must be implemented'); }
  printXReport(credentials) { throw new Error('printXReport must be implemented'); }
  printDuplicate(credentials) { throw new Error('printDuplicate must be implemented'); }
  rawRequest(requestFrame) { throw new Error('rawRequest must be implemented'); }
  reset(credentials) { throw new Error('reset must be implemented'); }
}
