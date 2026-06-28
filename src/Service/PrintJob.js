export const PrintJobAction = Object.freeze({
  None: 'None',
  Cash: 'Cash',
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
});

export const DEFAULT_TIMEOUT = 29000;

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
    const p = this.printer;
    const doc = this.document;

    switch (this.action) {
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
      default: throw new Error(`Unknown action: ${this.action}`);
    }
  }
}
