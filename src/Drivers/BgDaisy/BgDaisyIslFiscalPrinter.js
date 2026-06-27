import iconv from 'iconv-lite';
import { BgIslFiscalPrinter, CMD } from '../BgIslFiscalPrinter.js';
import { DeviceInfo } from '../../Core/DeviceInfo.js';
import { FiscalPrinterDriver } from '../../Core/FiscalPrinterDriver.js';
import { InvalidDeviceInfoException } from '../../Exceptions/InvalidDeviceInfoException.js';
import {
  DeviceStatusWithCashAmount,
  DeviceStatusWithReceiptInfo,
} from '../../Core/DeviceStatus.js';
import { ItemType, PriceModifierType, TaxGroup } from '../../Core/Item.js';
import { PaymentType } from '../../Core/Payment.js';
import { withMaxLength, wrapAtLength } from '../../Helpers/Helpers.js';

const SERIAL_NUMBER_PREFIX = 'DY';
const DRIVER_NAME = 'bg.dy.isl';

const DAISY_CMD_GET_DEVICE_CONSTANTS = 0x80;
const DAISY_CMD_ABORT_FISCAL_RECEIPT = 0x82;
const DAISY_CMD_FISCAL_RECEIPT_SALE_DEPARTMENT = 0x8A;

export class BgDaisyIslFiscalPrinter extends BgIslFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);

    this.paymentTypeMappings = {
      [PaymentType.Cash]: 'P',
      [PaymentType.Card]: 'C',
      [PaymentType.Check]: 'N',
      [PaymentType.Reserved1]: 'D',
    };
  }

  getDefaultOptions() {
    return {
      'Operator.ID': '1',
      'Operator.Password': '0000',
    };
  }

  async getRawDeviceConstants() {
    const resp = await this._sendCommand(DAISY_CMD_GET_DEVICE_CONSTANTS, null);
    return iconv.decode(resp || Buffer.alloc(0), 'cp1251');
  }

  async _addSale(item) {
    const taxText = this.getTaxGroupText(item.TaxGroup || TaxGroup.TaxGroup1);
    const text = withMaxLength(item.Text || '', this.info.ItemTextMaxLength || 20);
    const qty = (item.Quantity || 1).toFixed(3);
    const price = (item.UnitPrice || 0).toFixed(2);
    const dept = item.Department || 0;

    if (dept > 0) {
      // Department sale: "text\tdept@price\tqty"
      const str = `${text}\t${dept}@${price}\t${qty}`;
      await this._sendCommand(DAISY_CMD_FISCAL_RECEIPT_SALE_DEPARTMENT, str);
    } else {
      const str = `${text}\t${taxText}${price}\t${qty}`;
      await this._sendCommand(CMD.FiscalReceiptSale, str);
    }

    if (item.PriceModifierType !== PriceModifierType.None) {
      await this._applyPriceModifier(item);
    }
  }

  async _applyPriceModifier(item) {
    const val = (item.PriceModifierValue || 0).toFixed(2);
    let str;
    switch (item.PriceModifierType) {
      case PriceModifierType.DiscountPercent:   str = `\t\t-%${val}`; break;
      case PriceModifierType.DiscountAmount:    str = `\t\t-${val}`; break;
      case PriceModifierType.SurchargePercent:  str = `\t\t+%${val}`; break;
      case PriceModifierType.SurchargeAmount:   str = `\t\t+${val}`; break;
      default: return;
    }
    await this._sendCommand(CMD.Subtotal, str);
  }

  async reset(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(DAISY_CMD_ABORT_FISCAL_RECEIPT, null);
    } catch (e) {
      status.addError('E600', e.message);
    }
    return status;
  }

  async printMoneyDeposit(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithCashAmount();
    try {
      const amount = transferAmount.Amount.toFixed(2);
      const typeText = this.getPaymentTypeText(PaymentType.Cash);
      await this._sendCommand(CMD.MoneyTransfer, `${typeText},+${amount}`);
      status.Amount = transferAmount.Amount;
    } catch (e) {
      status.addError('E300', e.message);
    }
    return status;
  }

  async printMoneyWithdraw(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithCashAmount();
    try {
      const amount = transferAmount.Amount.toFixed(2);
      const typeText = this.getPaymentTypeText(PaymentType.Cash);
      await this._sendCommand(CMD.MoneyTransfer, `${typeText},-${amount}`);
      status.Amount = transferAmount.Amount;
    } catch (e) {
      status.addError('E300', e.message);
    }
    return status;
  }
}

export class BgDaisyIslFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() {
    return DRIVER_NAME;
  }

  async connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgDaisyIslFiscalPrinter(channel, serviceOptions, options);
    const cacheKey = `isl.${channel.descriptor}.${DRIVER_NAME}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      printer.info = cached;
      printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
      if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
      return printer;
    }

    const [rawDeviceInfo, rawConstants] = await Promise.all([
      printer.getRawDeviceInfo(),
      printer.getRawDeviceConstants(),
    ]);
    printer.info = parseDeviceInfo(rawDeviceInfo, rawConstants, autoDetect);
    this.cache.store(cacheKey, printer.info, 30000);
    printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
    printer.info.SupportsSubTotalAmountModifiers = true;
    if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
    return printer;
  }
}

function parseDeviceInfo(rawDeviceInfo, rawConstants, autoDetect) {
  const fields = rawDeviceInfo.split(',');
  if (fields.length < 6) throw new InvalidDeviceInfoException(`Cannot parse Daisy device info: ${rawDeviceInfo}`);

  const serialNumber = fields[0].trim();
  const fmSerial = fields[1].trim();
  const manufacturer = fields[2].trim();
  const model = fields[3].trim();
  const firmware = fields[4].trim();
  const taxId = fields[5].trim().replace(/-/g, '');

  if (autoDetect && !serialNumber.startsWith(SERIAL_NUMBER_PREFIX)) {
    throw new InvalidDeviceInfoException(`Serial ${serialNumber} must start with ${SERIAL_NUMBER_PREFIX} for ${DRIVER_NAME}`);
  }

  let commentTextMaxLength = 36;
  let itemTextMaxLength = 20;

  // Constants array: position 9 = CommentTextMaxLength, position 10 = ItemTextMaxLength
  if (rawConstants) {
    const constFields = rawConstants.split(',');
    if (constFields.length > 10) {
      commentTextMaxLength = parseInt(constFields[9], 10) || commentTextMaxLength;
      itemTextMaxLength = parseInt(constFields[10], 10) || itemTextMaxLength;
    }
  }

  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.Manufacturer = manufacturer || 'Daisy';
  info.Model = model;
  info.FirmwareVersion = firmware;
  info.TaxIdentificationNumber = taxId;
  info.CommentTextMaxLength = commentTextMaxLength;
  info.ItemTextMaxLength = itemTextMaxLength;
  info.OperatorPasswordMaxLength = 6;
  return info;
}

