'use strict';

const { BgIslFiscalPrinter, CMD } = require('../BgIslFiscalPrinter');
const { DeviceInfo } = require('../../Core/DeviceInfo');
const { FiscalPrinterDriver } = require('../../Core/FiscalPrinterDriver');
const { InvalidDeviceInfoException } = require('../../Exceptions/InvalidDeviceInfoException');

const SERIAL_NUMBER_PREFIXES = ['DT', 'DA'];
const DRIVER_NAME = 'bg.dt.p.isl';

class BgDatecsPIslFiscalPrinter extends BgIslFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this.info.CommentTextMaxLength = 46;
    this.info.ItemTextMaxLength = 34;
    this.info.OperatorPasswordMaxLength = 8;
  }

  getDefaultOptions() {
    return {
      'Operator.ID': '1',
      'Operator.Password': '0000',
    };
  }
}

class BgDatecsPIslFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() {
    return DRIVER_NAME;
  }

  connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgDatecsPIslFiscalPrinter(channel, serviceOptions, options);
    const cacheKey = `isl.${channel.descriptor}.${DRIVER_NAME}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      printer.info = parseDeviceInfo(cached, autoDetect);
      printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
      printer.info.SupportsSubTotalAmountModifiers = false;
      if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
      return printer;
    }

    return printer.getRawDeviceInfo().then(rawDeviceInfo => {
      this.cache.store(cacheKey, rawDeviceInfo, 30000);
      printer.info = parseDeviceInfo(rawDeviceInfo, autoDetect);
      printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
      printer.info.SupportsSubTotalAmountModifiers = false;
      if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
      return printer;
    });
  }
}

function parseDeviceInfo(rawDeviceInfo, autoDetect) {
  const fields = rawDeviceInfo.split(',');
  if (fields.length < 6) throw new InvalidDeviceInfoException(`Cannot parse Datecs P device info: ${rawDeviceInfo}`);

  const serialNumber = fields[0].trim();
  const fmSerial = fields[1].trim();
  const manufacturer = fields[2].trim();
  const model = fields[3].trim();
  const firmware = fields[4].trim();
  const taxId = fields[5].trim();

  if (autoDetect && !SERIAL_NUMBER_PREFIXES.some(p => serialNumber.startsWith(p))) {
    throw new InvalidDeviceInfoException(`Serial ${serialNumber} must start with DT or DA for ${DRIVER_NAME}`);
  }

  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.Manufacturer = manufacturer || 'Datecs';
  info.Model = model;
  info.FirmwareVersion = firmware;
  info.TaxIdentificationNumber = taxId;
  info.CommentTextMaxLength = 46;
  info.ItemTextMaxLength = 34;
  info.OperatorPasswordMaxLength = 8;
  return info;
}

module.exports = { BgDatecsPIslFiscalPrinter, BgDatecsPIslFiscalPrinterDriver };
