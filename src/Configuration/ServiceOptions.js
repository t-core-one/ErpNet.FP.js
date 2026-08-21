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

/**
 * Read a WebAccess block whatever casing it arrives in.
 *
 * The settings reach this object from two directions that disagreed on case.
 * The server's own web UI POSTs camelCase (`enablePrivateNetwork`) and that body
 * was persisted to appsettings.json verbatim, while every reader used PascalCase
 * like the rest of the options. Because the config is loaded with a shallow
 * Object.assign, a camelCase WebAccess block REPLACED this whole defaults object
 * instead of merging into it, so EnablePrivateNetwork read back as undefined:
 * the tickbox in the UI saved, reloaded ticked, and did nothing at all. On the
 * Sofia box that meant no Access-Control-Allow-Private-Network on the preflight,
 * so every POS POST to the LAN failed as "server not reachable".
 *
 * Normalising on the way in keeps exactly one casing inside the service and
 * leaves already-deployed appsettings.json files working untouched.
 */
export function normalizeWebAccess(raw) {
  const opts = new WebAccessOptions();
  if (!raw || typeof raw !== 'object') {
    return opts;
  }
  const pick = (...names) => names.map((n) => raw[n]).find((v) => v !== undefined);
  const origins = pick('AllowedOrigins', 'allowedOrigins');
  if (Array.isArray(origins)) {
    opts.AllowedOrigins = origins;
  }
  const enablePrivateNetwork = pick('EnablePrivateNetwork', 'enablePrivateNetwork');
  if (enablePrivateNetwork !== undefined) {
    opts.EnablePrivateNetwork = Boolean(enablePrivateNetwork);
  }
  return opts;
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
    // Serial (COM) line speed used for auto-detection and for configured
    // printers that do not pin their own. Not every fiscal printer runs at
    // 115200 — an FP-800 over RS-232 is often 9600 — and a mismatch is
    // indistinguishable from "no printer found". A single device can override
    // this in its URI: bg.dt.p.isl:///dev/ttyUSB0?baud=9600
    this.BaudRate = 115200;
    this.WebAccess = new WebAccessOptions();
    // Absolute path for the durable УНП counter state. Empty => the register
    // picks a default outside the app dir (USN_STATE_PATH env, else
    // ~/.erpnet-fp/usn-state.json) so a redeploy cannot wipe it.
    this.UsnStatePath = '';
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
