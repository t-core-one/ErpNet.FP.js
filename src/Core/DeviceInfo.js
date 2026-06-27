'use strict';

class DeviceInfo {
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
    this.SupportPaymentTerminal = false;
    this.UsePaymentTerminal = false;
  }
}

module.exports = { DeviceInfo };
