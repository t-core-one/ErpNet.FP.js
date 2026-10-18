import { DeviceStatus } from '../Core/DeviceStatus.js';

export const PrintJobAction = Object.freeze({
  None: 'None',
  Cash: 'Cash',
  Status: 'Status',
  RawRequest: 'RawRequest',
  Receipt: 'Receipt',
  ReversalReceipt: 'ReversalReceipt',
  Withdraw: 'Withdraw',
  Deposit: 'Deposit',
  XReport: 'XReport',
  ZReport: 'ZReport',
  MReport: 'MReport',
  SetDateTime: 'SetDateTime',
  Duplicate: 'Duplicate',
  Reset: 'Reset',
  Invoice: 'Invoice',
  CreditNote: 'CreditNote',
  ServiceReceipt: 'ServiceReceipt',
});

export const DEFAULT_TIMEOUT = 29000;

// Jobs the device refuses while a service receipt is open. Before each, a slip
// left open by an interrupted print (E703) is closed, so one failed voucher
// cannot stop the shop selling. Read-only jobs and raw requests are left alone;
// Reset and ServiceReceipt handle it themselves.
const NEEDS_NO_OPEN_SERVICE_RECEIPT = new Set([
  PrintJobAction.Receipt,
  PrintJobAction.ReversalReceipt,
  PrintJobAction.Invoice,
  PrintJobAction.CreditNote,
  PrintJobAction.Withdraw,
  PrintJobAction.Deposit,
  PrintJobAction.XReport,
  PrintJobAction.ZReport,
  PrintJobAction.MReport,
  PrintJobAction.Duplicate,
  PrintJobAction.SetDateTime,
]);

export class PrintJob {
  constructor({ printer, action, document, asyncTimeout = DEFAULT_TIMEOUT, timeout = 0, taskId = null } = {}) {
    this.printer = printer;
    this.action = action || PrintJobAction.None;
    this.document = document || null;
    this.asyncTimeout = asyncTimeout;
    this.timeout = timeout;
    this.taskId = taskId;
  }

  async run() {
    if (!NEEDS_NO_OPEN_SERVICE_RECEIPT.has(this.action)) {
      return this._dispatch();
    }
    let stale = null;
    try {
      stale = await this.printer.clearStaleServiceReceipt?.();
    } catch (_) {
      stale = null; // never let the check itself stop a sale
    }
    if (stale && stale.error) {
      const status = new DeviceStatus();
      status.addError('E703', `A service receipt left open by an interrupted print is blocking the device `
        + `and could not be closed (${stale.error}). Check the paper and the power, then try again.`);
      return status;
    }
    const status = await this._dispatch();
    if (stale && stale.closed && status && typeof status.addWarning === 'function') {
      status.addWarning('W703', 'Closed a service receipt that an interrupted print had left open');
    }
    return status;
  }

  async _dispatch() {
    const p = this.printer;
    const doc = this.document;

    switch (this.action) {
      case PrintJobAction.Status:          return p.checkStatus();
      case PrintJobAction.Cash:            return p.cash();
      case PrintJobAction.RawRequest:      return p.rawRequest(doc);
      case PrintJobAction.Receipt:         return p.printReceipt(doc);
      case PrintJobAction.ReversalReceipt: return p.printReversalReceipt(doc);
      case PrintJobAction.Withdraw:        return p.printMoneyWithdraw(doc);
      case PrintJobAction.Deposit:         return p.printMoneyDeposit(doc);
      case PrintJobAction.XReport:         return p.printXReport(doc);
      case PrintJobAction.ZReport:         return p.printZReport(doc);
      case PrintJobAction.MReport:         return p.printMonthlyReport(doc);
      case PrintJobAction.SetDateTime:     return p.setDateTime(doc);
      case PrintJobAction.Duplicate:       return p.printDuplicate(doc);
      case PrintJobAction.Reset:           return p.reset(doc);
      case PrintJobAction.Invoice:         return p.printInvoice(doc);
      case PrintJobAction.CreditNote:      return p.printCreditNote(doc);
      case PrintJobAction.ServiceReceipt:  return p.printServiceReceipt(doc);
      default: throw new Error(`Unknown action: ${this.action}`);
    }
  }
}
