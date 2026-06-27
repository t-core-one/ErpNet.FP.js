export class PrinterConfig {
  constructor() {
    this.Uri = '';
  }
}

export class PrinterConfigWithId extends PrinterConfig {
  constructor() {
    super();
    this.Id = '';
  }
}

export class PrinterProperties {
  constructor() {
    this.PaymentTypeMappings = {};
    this.PrinterConstants = {};
    this.PrinterOptions = {};
  }
}

export class WebAccessOptions {
  constructor() {
    this.AllowedOrigins = [];
    this.EnablePrivateNetwork = false;
  }
}

export class ServiceOptions {
  constructor() {
    this.AutoDetect = true;
    this.ServerId = '';
    this.Printers = {};
    this.UdpBeaconPort = 0;
    this.PrintersProperties = {};
    this.ExcludePortList = [];
    this.DetectionTimeout = '30s';
    this.WebAccess = new WebAccessOptions();
  }

  remapPaymentTypes(deviceInfo, paymentTypeMappings) {
    if (!paymentTypeMappings || !deviceInfo) return;
    const printerProps = this.PrintersProperties[deviceInfo.SerialNumber];
    if (printerProps && printerProps.PaymentTypeMappings) {
      Object.assign(paymentTypeMappings, printerProps.PaymentTypeMappings);
    }
  }

  reconfigurePrinterConstants(deviceInfo) {
    if (!deviceInfo) return;
    const printerProps = this.PrintersProperties[deviceInfo.SerialNumber];
    if (!printerProps || !printerProps.PrinterConstants) return;
    const constants = printerProps.PrinterConstants;
    if (constants.CommentTextMaxLength !== undefined) {
      deviceInfo.CommentTextMaxLength = parseInt(constants.CommentTextMaxLength, 10);
    }
    if (constants.ItemTextMaxLength !== undefined) {
      deviceInfo.ItemTextMaxLength = parseInt(constants.ItemTextMaxLength, 10);
    }
    if (constants.OperatorPasswordMaxLength !== undefined) {
      deviceInfo.OperatorPasswordMaxLength = parseInt(constants.OperatorPasswordMaxLength, 10);
    }
  }

  reconfigurePrinterOptions(deviceInfo, options) {
    if (!deviceInfo || !options) return;
    const printerProps = this.PrintersProperties[deviceInfo.SerialNumber];
    if (!printerProps || !printerProps.PrinterOptions) return;
    Object.assign(options, printerProps.PrinterOptions);
  }
}
