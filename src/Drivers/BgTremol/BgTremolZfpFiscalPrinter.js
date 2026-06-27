import { BgZfpFiscalPrinter } from '../BgZfp/BgZfpFiscalPrinter.js';
import { DeviceInfo } from '../../Core/DeviceInfo.js';
import { FiscalPrinterDriver } from '../../Core/FiscalPrinterDriver.js';
import { InvalidDeviceInfoException } from '../../Exceptions/InvalidDeviceInfoException.js';

const SERIAL_NUMBER_PREFIX = 'ZK';
const DRIVER_NAME = 'bg.zk.zfp';

export class BgTremolZfpFiscalPrinter extends BgZfpFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this.info.CommentTextMaxLength = 30;
    this.info.ItemTextMaxLength = 32;
    this.info.OperatorPasswordMaxLength = 6;
  }

  getDefaultOptions() {
    return { 'Operator.ID': '1', 'Operator.Password': '0000' };
  }
}

export class BgTremolZfpFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() { return DRIVER_NAME; }

  async connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgTremolZfpFiscalPrinter(channel, serviceOptions, options);
    const cacheKey = `zfp.${channel.descriptor}.${DRIVER_NAME}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      printer.info = parseDeviceInfo(cached, '', autoDetect);
      printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
      printer.info.SupportsSubTotalAmountModifiers = true;
      if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
      return printer;
    }

    const [versionStr, extraStr] = await printer.getRawDeviceInfo();
    this.cache.store(cacheKey, versionStr, 30000);
    printer.info = parseDeviceInfo(versionStr, extraStr, autoDetect);
    printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
    printer.info.SupportsSubTotalAmountModifiers = true;
    if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
    return printer;
  }
}

function parseDeviceInfo(rawDeviceInfo, extraStr, autoDetect) {
  const fields = rawDeviceInfo.split(';');
  if (fields.length < 4) throw new InvalidDeviceInfoException(`Cannot parse ZFP device info: ${rawDeviceInfo}`);

  const serialNumber = fields[0].trim();
  const fmSerial = fields[1].trim();
  const firmware = fields[2].trim();
  const modelName = fields[3].trim().replace(/tremol\s*/i, '');

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
