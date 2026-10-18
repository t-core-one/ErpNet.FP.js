export const StatusMessageType = Object.freeze({
  Unknown: 'unknown',
  Reserved: 'reserved',
  Info: 'info',
  Warning: 'warning',
  Error: 'error',
});

export class StatusMessage {
  constructor(type, code, text) {
    this.Type = type;
    this.Code = code;
    this.Text = text;
  }
}

export class DeviceStatus {
  constructor() {
    this.Ok = true;
    this.Messages = [];
  }

  addMessage(message) {
    this.Messages.push(message);
    if (message.Type === StatusMessageType.Error) {
      this.Ok = false;
    }
  }

  addInfo(code, text) {
    this.addMessage(new StatusMessage(StatusMessageType.Info, code, text));
  }

  addError(code, text) {
    this.addMessage(new StatusMessage(StatusMessageType.Error, code, text));
    this.Ok = false;
  }

  addWarning(code, text) {
    this.addMessage(new StatusMessage(StatusMessageType.Warning, code, text));
  }
}

export class DeviceStatusWithDateTime extends DeviceStatus {
  constructor() {
    super();
    this.DeviceDateTime = null;
  }
}

export class DeviceStatusWithRawResponse extends DeviceStatus {
  constructor() {
    super();
    this.RawResponse = '';
  }
}

export class DeviceStatusWithCashAmount extends DeviceStatus {
  constructor() {
    super();
    this.Amount = 0;
  }
}

export class DeviceStatusWithReceiptInfo extends DeviceStatus {
  constructor() {
    super();
    this.ReceiptNumber = '';
    this.ReceiptDateTime = null;
    this.ReceiptAmount = 0;
    this.FiscalMemorySerialNumber = '';
  }
}

/**
 * Result of a service receipt (СЛУЖЕБЕН БОН). SlipNumber is the device's own
 * document number for the slip, as it answered the close command — worth
 * storing next to the voucher, since it is what the electronic journal (КЛЕН)
 * knows the slip by. LinesPrinted counts physical lines after wrapping.
 */
export class DeviceStatusWithServiceReceipt extends DeviceStatus {
  constructor() {
    super();
    this.SlipNumber = '';
    this.LinesPrinted = 0;
  }
}
