import { FiscalPrinterDriver } from '../../Core/FiscalPrinterDriver.js';
import { DeviceInfo } from '../../Core/DeviceInfo.js';
import { NumberAssignment } from '../../Core/NumberAssignment.js';
import { InvalidDeviceInfoException } from '../../Exceptions/InvalidDeviceInfoException.js';
import { BgSisJsonFiscalPrinter } from './BgSisJsonFiscalPrinter.js';

const DRIVER_NAME = 'bg.sis.json';

// FDNumber must match 2 uppercase letters followed by 6 digits, e.g. "DT970048".
const FISCAL_DEVICE_NUMBER_PATTERN = /^[A-Z]{2}[0-9]{6}$/;

/**
 * Returns the printable text limits for a known SIS model.
 * commentMax is the per-line comment character limit.
 * itemMax is the sale description character limit.
 * Note: "31" is NOT a length limit — it is the boundary beyond which digits are
 * rejected in comment lines. That rule lives in BgSisJsonFiscalPrinter validation.
 */
function getTextLimitsForModel(model) {
  switch (model) {
    case 'MF-P1200DN':   return { commentMax: 42, itemMax: 64 };
    case 'MF-TH250QR':   return { commentMax: 42, itemMax: 64 };
    case 'MF-TH230QR':   return { commentMax: 42, itemMax: 64 };
    case 'BULPRINT T2QR': return { commentMax: 46, itemMax: 64 };
    case 'BULPRINT T3QR': return { commentMax: 46, itemMax: 64 };
    default:             return { commentMax: 42, itemMax: 64 };
  }
}

/**
 * Parses the raw getMfcInfo JSON string into a DeviceInfo.
 * @param {string} rawDeviceInfo  Stringified getMfcInfo response JSON.
 * @param {string} model          printerModel from getStatus.
 * @param {string} fwChecksum     fwChecksum from getStatus.
 * @param {boolean} autoDetect    When true, validates FDNumber format and non-empty model.
 */
function parseDeviceInfo(rawDeviceInfo, model, fwChecksum, autoDetect) {
  let json;
  try {
    json = JSON.parse(rawDeviceInfo);
  } catch (e) {
    throw new InvalidDeviceInfoException(
      `getMfcInfo did not return valid JSON for '${DRIVER_NAME}': ${e.message}`);
  }

  const fdNumber = ((json.FDNumber || '') + '').trim();
  const fmNumber = ((json.FMNumber || '') + '').trim();
  const idNumber = ((json.IDNumber || '') + '').trim();

  if (autoDetect) {
    if (!FISCAL_DEVICE_NUMBER_PATTERN.test(fdNumber)) {
      throw new InvalidDeviceInfoException(
        `FDNumber '${fdNumber}' is not in the expected format (2 letters + 6 digits) for '${DRIVER_NAME}'`);
    }
    if (!model) {
      throw new InvalidDeviceInfoException(`printerModel is empty for '${DRIVER_NAME}'`);
    }
  }

  const { commentMax, itemMax } = getTextLimitsForModel(model);

  const info = new DeviceInfo();
  info.SerialNumber = fdNumber;
  info.FiscalMemorySerialNumber = fmNumber;
  info.SupportsPeriodReport = true;
  info.Model = model || 'SIS Fiscal Module';
  info.FirmwareVersion = fwChecksum;
  info.Manufacturer = 'SIS Technology';
  info.TaxIdentificationNumber = idNumber;
  info.CommentTextMaxLength = commentMax;
  info.ItemTextMaxLength = itemMax;
  info.OperatorPasswordMaxLength = 8;
  return info;
}

export class BgSisJsonFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() {
    return DRIVER_NAME;
  }

  async connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgSisJsonFiscalPrinter(channel, serviceOptions, options);
    const cacheKey = `sis.${channel.descriptor}.${DRIVER_NAME}`;

    let rawDeviceInfo = this.cache.get(cacheKey);
    if (!rawDeviceInfo) {
      const { raw } = await printer.getRawDeviceInfo();
      rawDeviceInfo = raw;
      // Cache for 30 seconds so repeated detection probes reuse the same info.
      this.cache.store(cacheKey, rawDeviceInfo, 30_000);
    }

    const { model, fwChecksum } = await printer.getModelAndChecksum();
    printer.info = parseDeviceInfo(rawDeviceInfo, model, fwChecksum, autoDetect);

    // Apply configurable payment type remappings from appsettings.json.
    if (serviceOptions) {
      serviceOptions.remapPaymentTypes(printer.info, printer.paymentTypeMappings);
    }

    printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();

    // Subtotal (receipt-level) amount modifiers are supported, but the SIS module
    // requires a VAT category (enumVatCategory) on each entry.
    printer.info.SupportsSubTotalAmountModifiers = true;
    printer.info.SubTotalAmountModifiersRequireTaxGroup = true;

    // The SIS module prints extended fiscal receipts (invoice / credit note).
    // The number (invNumber) must always be supplied by the caller; the device never assigns it.
    printer.info.SupportsInvoice = true;
    printer.info.SupportsCreditNote = true;
    printer.info.InvoiceNumberAssignment = NumberAssignment.ExternalRequired;
    printer.info.CreditNoteNumberAssignment = NumberAssignment.ExternalRequired;

    if (serviceOptions) {
      serviceOptions.reconfigurePrinterConstants(printer.info);
    }

    return printer;
  }
}
