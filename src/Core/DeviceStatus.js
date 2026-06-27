'use strict';

const StatusMessageType = Object.freeze({
  Unknown: 'unknown',
  Reserved: 'reserved',
  Info: 'info',
  Warning: 'warning',
  Error: 'error',
});

class StatusMessage {
  constructor(type, code, text) {
    this.Type = type;
    this.Code = code;
    this.Text = text;
  }
}

class DeviceStatus {
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

class DeviceStatusWithDateTime extends DeviceStatus {
  constructor() {
    super();
    this.DeviceDateTime = null;
  }
}

class DeviceStatusWithRawResponse extends DeviceStatus {
  constructor() {
    super();
    this.RawResponse = '';
  }
}

class DeviceStatusWithCashAmount extends DeviceStatus {
  constructor() {
    super();
    this.Amount = 0;
  }
}

class DeviceStatusWithReceiptInfo extends DeviceStatus {
  constructor() {
    super();
    this.ReceiptNumber = '';
    this.ReceiptDateTime = null;
    this.ReceiptAmount = 0;
    this.FiscalMemorySerialNumber = '';
  }
}

module.exports = {
  StatusMessageType,
  StatusMessage,
  DeviceStatus,
  DeviceStatusWithDateTime,
  DeviceStatusWithRawResponse,
  DeviceStatusWithCashAmount,
  DeviceStatusWithReceiptInfo,
};
