export class DeviceInfo {
  constructor() {
    this.Uri = '';
    this.SerialNumber = '';
    this.FiscalMemorySerialNumber = '';
    this.Manufacturer = '';
    this.Model = '';
    this.FirmwareVersion = '';
    this.ItemTextMaxLength = 0;
    this.CommentTextMaxLength = 0;
    this.OperatorPasswordMaxLength = 0;
    this.TaxIdentificationNumber = '';
    this.SupportedPaymentTypes = [];
    this.SupportsSubTotalAmountModifiers = false;
    this.SubTotalAmountModifiersRequireTaxGroup = false;
    // Fiscal memory report for a custom period (from date to date).
    this.SupportsPeriodReport = false;
    // Free-text service receipt (СЛУЖЕБЕН БОН), e.g. a ПКО/РКО voucher. Set only by
    // drivers whose open/print/close commands were checked against the device's
    // protocol manual; POST /printers/{id}/servicereceipt refuses otherwise.
    this.SupportsServiceReceipt = false;
    this.SupportsInvoice = false;
    this.SupportsCreditNote = false;
    this.InvoiceNumberAssignment = 'device-assigned';
    this.CreditNoteNumberAssignment = 'device-assigned';
    this.SupportPaymentTerminal = false;
    this.UsePaymentTerminal = false;
  }
}
