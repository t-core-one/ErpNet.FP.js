'use strict';

const iconv = require('iconv-lite');
const { BgZfpFiscalPrinter } = require('../BgZfp/BgZfpFiscalPrinter');
const { DeviceInfo } = require('../../Core/DeviceInfo');
const { FiscalPrinterDriver } = require('../../Core/FiscalPrinterDriver');
const { InvalidDeviceInfoException } = require('../../Exceptions/InvalidDeviceInfoException');

const SERIAL_NUMBER_PREFIX = 'ZK';
const DRIVER_NAME = 'bg.zk.zfp';

class BgTremolZfpFiscalPrinter extends BgZfpFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this.info.CommentTextMaxLength = 30;
    this.info.ItemTextMaxLength = 32;
    this.info.OperatorPasswordMaxLength = 6;
  }

  getDefaultOptions() {
    return {
      'Operator.ID': '1',
      'Operator.Password': '0000',
    };
  }
}

class BgTremolZfpFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() {
    return DRIVER_NAME;
  }

  connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgTremolZfpFiscalPrinter(channel, serviceOptions, options);
    const cacheKey = `zfp.${channel.descriptor}.${DRIVER_NAME}`;

    const cached = this.cache.get(cacheKey);
    let rawDeviceInfo;
    if (cached) {
      rawDeviceInfo = cached;
    } else {
      // Synchronous-style: we return a promise-like object but the caller
      // may await it in the Provider.
      return printer.getRawDeviceInfo().then(([versionStr, extraStr]) => {
        rawDeviceInfo = versionStr;
        this.cache.store(cacheKey, rawDeviceInfo, 30000);
        printer.info = parseDeviceInfo(rawDeviceInfo, extraStr, autoDetect);
        printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
        printer.info.SupportsSubTotalAmountModifiers = true;
        if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
        return printer;
      });
    }

    printer.info = parseDeviceInfo(rawDeviceInfo, '', autoDetect);
    printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
    printer.info.SupportsSubTotalAmountModifiers = true;
    if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
    return printer;
  }
}

function parseDeviceInfo(rawDeviceInfo, extraStr, autoDetect) {
  // rawDeviceInfo: 7 fields separated by semicolons
  // e.g. "SerialNo;FMSerial;FirmwareVersion;ModelName;..."
  const fields = rawDeviceInfo.split(';');
  if (fields.length < 4) throw new InvalidDeviceInfoException(`Cannot parse ZFP device info: ${rawDeviceInfo}`);

  const serialNumber = fields[0].trim();
  const fmSerial = fields[1].trim();
  const firmware = fields[2].trim();
  let modelName = fields[3].trim().replace('TREMOL ', '').replace('Tremol ', '');

  if (autoDetect && !serialNumber.startsWith(SERIAL_NUMBER_PREFIX)) {
    throw new InvalidDeviceInfoException(`Serial number must start with ${SERIAL_NUMBER_PREFIX} for ${DRIVER_NAME}`);
  }

  if (modelName.toUpperCase().endsWith('V2')) {
    throw new InvalidDeviceInfoException(`Model ${modelName} is V2 — use bg.zk.v2.zfp driver`);
  }

  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.FirmwareVersion = firmware;
  info.Model = modelName;
  info.Manufacturer = 'Tremol';
  info.CommentTextMaxLength = 30;
  info.ItemTextMaxLength = 32;
  info.OperatorPasswordMaxLength = 6;

  if (extraStr) {
    const parts = extraStr.split(';');
    if (parts.length >= 1) info.TaxIdentificationNumber = parts[0].trim();
  }

  return info;
}

module.exports = { BgTremolZfpFiscalPrinter, BgTremolZfpFiscalPrinterDriver };
