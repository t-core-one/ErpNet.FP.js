'use strict';

const { BgIcpFiscalPrinter } = require('../BgIcpFiscalPrinter');
const { DeviceInfo } = require('../../Core/DeviceInfo');
const { FiscalPrinterDriver } = require('../../Core/FiscalPrinterDriver');
const { InvalidDeviceInfoException } = require('../../Exceptions/InvalidDeviceInfoException');
const iconv = require('iconv-lite');

const SERIAL_NUMBER_PREFIX = 'IS';
const DRIVER_NAME = 'bg.is.icp';

class BgIslIcpFiscalPrinter extends BgIcpFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
  }

  getDefaultOptions() {
    return {
      'Operator.ID': '1',
      'Operator.Password': '',
    };
  }
}

class BgIslIcpFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() {
    return DRIVER_NAME;
  }

  connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgIslIcpFiscalPrinter(channel, serviceOptions, options);
    const cacheKey = `icp.${channel.descriptor}.${DRIVER_NAME}`;

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

function getPrintColumnsOfModel(modelName) {
  if (modelName.startsWith('ISL5011')) return 47;
  if (modelName.startsWith('ISL3818')) return 47;
  if (modelName.startsWith('ISL5021')) return 64;
  if (modelName.startsWith('ISL756'))  return 48;
  if (modelName.startsWith('ISL3811')) return 32;
  return 47;
}

function parseDeviceInfo(rawDeviceInfo, autoDetect) {
  // rawDeviceInfo: "tabFields[0]\ttabFields[1]"
  // tabFields[0]: fixed-width chunks [8,8,14,4,10,1,1] = 46 chars
  // tabFields[1]: "modelName firmwareVersion"
  const tabFields = rawDeviceInfo.split('\t', 2);
  if (tabFields.length < 2) throw new InvalidDeviceInfoException(`Cannot parse ISL ICP device info: ${rawDeviceInfo}`);

  const chunkSizes = [8, 8, 14, 4, 10, 1, 1];
  let offset = 0;
  const fields = [];
  for (const size of chunkSizes) {
    fields.push(tabFields[0].substring(offset, offset + size));
    offset += size;
  }

  const spaceFields = tabFields[1].split(' ', 2);
  if (spaceFields.length < 2) throw new InvalidDeviceInfoException(`Cannot parse ISL ICP device info model: ${tabFields[1]}`);

  const serialNumber = fields[0].trim();
  const fmSerial = fields[1].trim();
  const taxId = fields[2].trim();
  const modelName = spaceFields[0].trim();
  const firmware = spaceFields[1].trim();

  if (autoDetect && (!serialNumber.startsWith(SERIAL_NUMBER_PREFIX) || serialNumber.length !== 8)) {
    throw new InvalidDeviceInfoException(`Serial ${serialNumber} must start with ${SERIAL_NUMBER_PREFIX} and be 8 chars for ${DRIVER_NAME}`);
  }

  const printColumns = getPrintColumnsOfModel(modelName);
  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.Manufacturer = 'ISL';
  info.Model = modelName;
  info.FirmwareVersion = firmware;
  info.TaxIdentificationNumber = taxId;
  info.CommentTextMaxLength = printColumns - 2;
  info.ItemTextMaxLength = 40;
  info.OperatorPasswordMaxLength = 0;
  return info;
}

module.exports = { BgIslIcpFiscalPrinter, BgIslIcpFiscalPrinterDriver };
