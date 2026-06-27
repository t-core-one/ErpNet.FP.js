import iconv from 'iconv-lite';
import { BgIslFiscalPrinter, CMD } from '../BgIslFiscalPrinter.js';
import { DeviceInfo } from '../../Core/DeviceInfo.js';
import { FiscalPrinterDriver } from '../../Core/FiscalPrinterDriver.js';
import { InvalidDeviceInfoException } from '../../Exceptions/InvalidDeviceInfoException.js';
import {
  DeviceStatusWithDateTime,
  DeviceStatusWithCashAmount,
  DeviceStatusWithReceiptInfo,
} from '../../Core/DeviceStatus.js';
import { ItemType, PriceModifierType, TaxGroup } from '../../Core/Item.js';
import { PaymentType } from '../../Core/Payment.js';
import { withMaxLength, wrapAtLength } from '../../Helpers/Helpers.js';

const SERIAL_NUMBER_PREFIXES = ['DT', 'DA'];
const DRIVER_NAME = 'bg.dt.x.isl';
const CMD_OPEN_STORNO = 0x2B;

export class BgDatecsXIslFiscalPrinter extends BgIslFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this.info.SupportPaymentTerminal = true;

    this.paymentTypeMappings = {
      [PaymentType.Cash]: '0',
      [PaymentType.Check]: '3',
      [PaymentType.Coupons]: '5',
      [PaymentType.ExtCoupons]: '4',
      [PaymentType.Card]: '1',
    };
  }

  getDefaultOptions() {
    return {
      'Operator.ID': '1',
      'Operator.Password': '0000',
    };
  }

  _formatOpenReceipt(receipt) {
    const op = receipt.Operator || '1';
    const pass = receipt.OperatorPassword || '';
    const usn = receipt.UniqueSaleNumber || '';
    return `${op}\t${pass}\t\t${usn}`;
  }

  _formatOpenReversalReceipt(reversalReceipt) {
    const op = reversalReceipt.Operator || '1';
    const pass = reversalReceipt.OperatorPassword || '';
    const usn = reversalReceipt.UniqueSaleNumber || '';
    const receiptNum = reversalReceipt.ReceiptNumber || '';
    const fmSerial = reversalReceipt.FiscalMemorySerialNumber || '';
    const reason = this.getReversalReasonText(reversalReceipt.Reason);
    const dtStr = reversalReceipt.ReceiptDateTime
      ? this._formatDateForReversal(reversalReceipt.ReceiptDateTime) : '';
    return `${op}\t${pass}\t\t${usn}\t${reason}\t${receiptNum}\t${fmSerial}\t${dtStr}`;
  }

  async _openReversalReceipt(reversalReceipt) {
    await this._sendCommand(CMD_OPEN_STORNO, this._formatOpenReversalReceipt(reversalReceipt));
  }

  async _addSale(item) {
    const taxText = this.getTaxGroupText(item.TaxGroup || TaxGroup.TaxGroup1);
    const text = withMaxLength(item.Text || '', this.info.ItemTextMaxLength || 36);
    const qty = (item.Quantity || 1).toFixed(3);
    const price = (item.UnitPrice || 0).toFixed(2);
    const dept = item.Department || 0;

    let str;
    if (dept > 0) {
      str = `${text}\t${taxText}${price}\t${qty}\t${dept}`;
    } else {
      str = `${text}\t${taxText}${price}\t${qty}`;
    }
    await this._sendCommand(CMD.FiscalReceiptSale, str);

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

  async _addComment(text) {
    const lines = wrapAtLength(text, this.info.CommentTextMaxLength || 36);
    for (const line of lines) {
      await this._sendCommand(CMD.FiscalReceiptComment, `${line}\t`);
    }
  }

  async _addPayment(payment) {
    const typeText = this.getPaymentTypeText(payment.PaymentType);
    const amount = (payment.Amount || 0).toFixed(2);
    let str = `${typeText}\t${amount}\t`;

    if (this.info.UsePaymentTerminal && payment.PaymentType === PaymentType.Card) {
      // Use payment terminal
      str = `${typeText}\t${amount}\t1`;
    }

    const resp = await this._sendCommand(CMD.FiscalReceiptTotal, str);
    // Check for pinpad errors if payment terminal used
    if (this.info.UsePaymentTerminal) {
      const respStr = iconv.decode(resp || Buffer.alloc(0), 'cp1251');
      this._checkPinpadResponse(respStr);
    }
  }

  _checkPinpadResponse(respStr) {
    if (!respStr) return;
    // Error codes are negative: -111xxx
    const match = respStr.match(/-111(\d+)/);
    if (match) {
      const code = parseInt(match[1], 10);
      // Common codes: pinpad errors
      throw new Error(`Pinpad error code: ${code}`);
    }
  }

  async setDateTime(datetime) {
    const dt = datetime.DeviceDateTime || new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const str = `${pad2(dt.getDate())}-${pad2(dt.getMonth() + 1)}-${String(dt.getFullYear()).slice(-2)} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}\t`;
    const status = new DeviceStatusWithDateTime();
    try {
      await this._sendCommand(CMD.SetDateTime, str);
      status.DeviceDateTime = dt;
    } catch (e) {
      status.addError('E002', e.message);
    }
    return status;
  }

  async cash() {
    const status = new DeviceStatusWithCashAmount();
    try {
      const resp = await this._sendCommand(CMD.GetReceiptStatus, null);
      const str = iconv.decode(resp || Buffer.alloc(0), 'cp1251');
      const parts = str.split('\t');
      status.Amount = parseFloat(parts[1] || '0') || 0;
    } catch (e) {
      status.addError('E003', e.message);
    }
    return status;
  }

  async printZReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.PrintDailyReport, 'Z\t');
    } catch (e) {
      status.addError('E400', e.message);
    }
    return status;
  }

  async printXReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.PrintDailyReport, 'X\t');
    } catch (e) {
      status.addError('E401', e.message);
    }
    return status;
  }

  async printMoneyDeposit(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithCashAmount();
    try {
      const amount = transferAmount.Amount.toFixed(2);
      await this._sendCommand(CMD.MoneyTransfer, `0\t${amount}\t`);
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
      await this._sendCommand(CMD.MoneyTransfer, `1\t${amount}\t`);
      status.Amount = transferAmount.Amount;
    } catch (e) {
      status.addError('E300', e.message);
    }
    return status;
  }
}

export class BgDatecsXIslFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() {
    return DRIVER_NAME;
  }

  async connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgDatecsXIslFiscalPrinter(channel, serviceOptions, options);
    const cacheKey = `isl.${channel.descriptor}.${DRIVER_NAME}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      printer.info = parseDeviceInfo(cached, autoDetect);
      printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
      printer.info.SupportsSubTotalAmountModifiers = true;
      if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
      return printer;
    }

    const rawDeviceInfo = await printer.getRawDeviceInfo();
    this.cache.store(cacheKey, rawDeviceInfo, 30000);
    printer.info = parseDeviceInfo(rawDeviceInfo, autoDetect);
    printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
    printer.info.SupportsSubTotalAmountModifiers = true;
    if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
    return printer;
  }
}

function getPrintColumnsOfModel(model) {
  model = (model || '').toUpperCase();
  if (model.includes('XR')) return 48;
  if (model.includes('XE')) return 42;
  return 48;
}

function parseDeviceInfo(rawDeviceInfo, autoDetect) {
  // Datecs X: 8 fields (comma and tab mixed)
  const fields = rawDeviceInfo.split(/[,\t ]/);
  if (fields.length < 6) throw new InvalidDeviceInfoException(`Cannot parse Datecs X device info: ${rawDeviceInfo}`);

  const serialNumber = fields[0].trim();
  const fmSerial = fields[1].trim();
  const manufacturer = fields[2] ? fields[2].trim() : 'Datecs';
  const model = fields[3] ? fields[3].trim() : '';
  const firmware = fields[4] ? fields[4].trim() : '';
  const taxId = fields[5] ? fields[5].trim() : '';

  if (autoDetect && !SERIAL_NUMBER_PREFIXES.some(p => serialNumber.startsWith(p))) {
    throw new InvalidDeviceInfoException(`Serial ${serialNumber} must start with DT or DA for ${DRIVER_NAME}`);
  }

  const printColumns = getPrintColumnsOfModel(model);
  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.Manufacturer = manufacturer;
  info.Model = model;
  info.FirmwareVersion = firmware;
  info.TaxIdentificationNumber = taxId;
  info.CommentTextMaxLength = printColumns - 2;
  info.ItemTextMaxLength = printColumns - 2;
  info.OperatorPasswordMaxLength = 8;
  info.SupportPaymentTerminal = true;
  return info;
}

