import iconv from 'iconv-lite';
import { DeviceInfo } from '../Core/DeviceInfo.js';
import { DeviceStatusWithReceiptInfo } from '../Core/DeviceStatus.js';
import { PaymentType } from '../Core/Payment.js';
import { ItemType, PriceModifierType } from '../Core/Item.js';
import { ReversalReason } from '../Core/ReversalReceipt.js';
import { RecipientIdentifierType } from '../Core/Recipient.js';
import { NumberAssignment } from '../Core/NumberAssignment.js';
import { InvoiceInfo } from '../Core/InvoiceInfo.js';

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
    // Per protocol: missing payments section → print full amount as cash (no error)
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

  validateInvoiceDocument(status, document, numberAssignment, documentName) {
    const recipient = document.Recipient;
    if (!recipient) {
      status.addError('E405', `${documentName} requires a "recipient"`);
      return status;
    }
    if (!recipient.Name)
      status.addError('E405', `${documentName} recipient requires a "name"`);
    if (!recipient.Identifier)
      status.addError('E405', `${documentName} recipient requires an "identifier"`);
    if (!recipient.IdentifierType || recipient.IdentifierType === RecipientIdentifierType.Unspecified)
      status.addError('E405', `${documentName} recipient requires an "identifierType"`);
    if (!recipient.Address)
      status.addError('E405', `${documentName} recipient requires an "address"`);
    if (!document.Number && numberAssignment === NumberAssignment.ExternalRequired)
      status.addError('E405', `${documentName} number is required by this device`);
    if (document.Number && numberAssignment === NumberAssignment.DeviceAssigned)
      status.addError('E412', `${documentName} external number not supported by this device`);
    return status;
  }

  validateInvoice(invoice) {
    // Accumulate all field errors into one status (matches .NET ValidateInvoiceCore).
    // validateInvoiceDocument mutates and returns the same status object.
    const status = this.validateReceipt(invoice);
    return this.validateInvoiceDocument(status, invoice, this.info.InvoiceNumberAssignment, 'invoice');
  }

  validateCreditNote(creditNote) {
    const status = this.validateReversalReceipt(creditNote);
    this.validateInvoiceDocument(status, creditNote, this.info.CreditNoteNumberAssignment, 'credit note');
    if (!creditNote.OriginalInvoiceNumber)
      status.addError('E405', 'Credit note requires an "originalInvoiceNumber"');
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

  /**
   * Fiscal memory report for a custom period.
   *
   * A base implementation on purpose: the route calls this unconditionally, and
   * a protocol family that has not implemented it (ICP and ZFP were in that
   * position) would otherwise raise a bare TypeError that reaches the caller as
   * a 500 with no device status at all. An unsupported device should answer
   * like any other refusing device.
   */
  printMonthlyReport(periodReport) {
    const status = new DeviceStatusWithReceiptInfo();
    status.addError('E413', 'Fiscal memory report for a period is not supported by this device');
    return status;
  }

  /**
   * Check only the bounds of the requested period. Everything else is left to
   * the device, so its own rejection reaches the caller rather than being
   * pre-empted by a guess about what it will accept.
   */
  validatePeriodReport(periodReport) {
    const status = new DeviceStatusWithReceiptInfo();
    const start = periodReport && (periodReport.StartDate || periodReport.startDate);
    const end = periodReport && (periodReport.EndDate || periodReport.endDate);
    if (!start) {
      status.addError('E405', 'StartDate of the period report is empty');
      return status;
    }
    if (!end) {
      status.addError('E405', 'EndDate of the period report is empty');
      return status;
    }
    const s = new Date(start);
    const e = new Date(end);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      status.addError('E405', 'StartDate or EndDate of the period report is not a valid date');
      return status;
    }
    if (s > e) {
      status.addError('E403', 'StartDate of the period report is after its EndDate');
    }
    return status;
  }

  // Base stubs: devices that do not support invoicing return E413.
  // The SIS driver overrides these with real logic; validateInvoice /
  // validateCreditNote above are the reusable field validators it calls.
  printInvoice(invoice) {
    const status = new DeviceStatusWithReceiptInfo();
    status.addError('E413', 'Invoice printing is not supported by this device');
    return { receiptInfo: new InvoiceInfo(), deviceStatus: status };
  }

  printCreditNote(creditNote) {
    const status = new DeviceStatusWithReceiptInfo();
    status.addError('E413', 'Credit note printing is not supported by this device');
    return { receiptInfo: new InvoiceInfo(), deviceStatus: status };
  }
}
