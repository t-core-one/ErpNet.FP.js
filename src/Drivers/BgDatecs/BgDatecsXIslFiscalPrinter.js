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
import { ReversalReason } from '../../Core/ReversalReceipt.js';
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

  // Protocol (no USN): {op}\t{pass}\t1\t\t
  // Protocol (with USN): {op}\t{pass}\t{usn}\t1\t\t
  _formatOpenReceipt(receipt) {
    const op = receipt.Operator || '1';
    const pass = receipt.OperatorPassword || '0000';
    const usn = receipt.UniqueSaleNumber || '';
    return usn
      ? [op, pass, usn, '1', '', ''].join('\t')
      : [op, pass, '1', '', ''].join('\t');
  }

  getReversalReasonText(reason) {
    switch (reason) {
      case ReversalReason.OperatorError: return '0';
      case ReversalReason.Refund: return '1';
      case ReversalReason.TaxBaseReduction: return '2';
      case 'taxbase-reduction': return '2';
      default: return '0';
    }
  }

  // Protocol: {op}\t{pass}\t1\t{reason}\t{receiptNum}\t{dd-MM-yy HH:mm:ss}\t{fmSerial}\t\t\t{usn}\t
  _formatOpenReversalReceipt(reversalReceipt) {
    const op = reversalReceipt.Operator || '1';
    const pass = reversalReceipt.OperatorPassword || '0000';
    const usn = reversalReceipt.UniqueSaleNumber || '';
    const receiptNum = reversalReceipt.ReceiptNumber || '';
    const fmSerial = reversalReceipt.FiscalMemorySerialNumber || '';
    const reason = this.getReversalReasonText(reversalReceipt.Reason);
    const dt = reversalReceipt.ReceiptDateTime || new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const yr2 = String(dt.getFullYear()).slice(-2);
    const dtStr = `${pad2(dt.getDate())}-${pad2(dt.getMonth() + 1)}-${yr2} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
    return [op, pass, '1', reason, receiptNum, dtStr, fmSerial, '', '', '', usn, ''].join('\t');
  }

  async _openReversalReceipt(reversalReceipt) {
    await this._sendCommand(CMD_OPEN_STORNO, this._formatOpenReversalReceipt(reversalReceipt));
  }

  async _addSale(item) {
    const taxText = this.getTaxGroupText(item.TaxGroup || TaxGroup.TaxGroup1);
    const text = withMaxLength(item.Text || '', this.info.ItemTextMaxLength || 72);
    const price = (item.UnitPrice || 0).toFixed(2);
    const dept = item.Department || 0;
    const qty = item.Quantity || 0;
    const modType = this._priceModifierTypeCode(item.PriceModifierType);
    const modVal = item.PriceModifierType
      ? (item.PriceModifierValue || 0).toFixed(2) : '0.00';
    // Protocol: {text}\t{taxCd}\t{price}\t{qty}\t{modType}\t{modValue}\t{dept}\t
    const str = [text, taxText, price,
      qty !== 0 ? String(qty) : '',
      modType, modVal, dept > 0 ? String(dept) : '', ''].join('\t');
    await this._sendCommand(CMD.FiscalReceiptSale, str);
  }

  _priceModifierTypeCode(type) {
    switch (type) {
      case PriceModifierType.DiscountPercent:  return '2';
      case PriceModifierType.DiscountAmount:   return '4';
      case PriceModifierType.SurchargePercent: return '1';
      case PriceModifierType.SurchargeAmount:  return '3';
      default: return '0';
    }
  }

  async _addComment(text) {
    const lines = wrapAtLength(text, this.info.CommentTextMaxLength || 36);
    for (const line of lines) {
      await this._sendCommand(CMD.FiscalReceiptComment, `${line}\t`);
    }
  }

  async _addPayment(payment) {
    // Protocol: {PaidMode}\t{Amount}\t{Type}\t   where Type=1 (normal) or 2 (pinpad)
    const typeText = this.getPaymentTypeText(payment.PaymentType);
    const amount = (payment.Amount || 0).toFixed(2);
    const terminalFlag = (this.info.UsePaymentTerminal && payment.PaymentType === PaymentType.Card) ? '2' : '1';
    const str = [typeText, amount, terminalFlag, ''].join('\t');
    const resp = await this._sendCommand(CMD.FiscalReceiptTotal, str);
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
    const raw = datetime && datetime.DeviceDateTime;
    const dt = raw ? new Date(raw) : new Date();
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
      const resp = await this._sendCommand(CMD.MoneyTransfer, '0\t0\t');
      const str = iconv.decode(resp || Buffer.alloc(0), 'cp1251');
      const parts = str.split('\t');
      if (parts.length !== 5) {
        status.addError('E409', 'Invalid format of cash response');
        return status;
      }
      const amountStr = parts[1] || '0';
      const raw = parseFloat(amountStr) || 0;
      status.Amount = amountStr.includes('.') ? raw : raw / 100;
    } catch (e) {
      status.addError('E003', e.message);
    }
    return status;
  }

  async printZReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.PrintDailyReport, 'Z\t', 1, 90000);
    } catch (e) {
      status.addError('E400', e.message);
    }
    return status;
  }

  async printXReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.PrintDailyReport, 'X\t', 3, 30000);
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
  // Datecs X response (split by comma, space, or tab produces 8 fields):
  // Model,FW_part1,FW_part2,FW_part3,Flags1,Flags2,SerialNumber,FMSerial
  const fields = rawDeviceInfo.split(/[,\t ]/);
  if (fields.length !== 8) throw new InvalidDeviceInfoException(`rawDeviceInfo must contain 8 fields for '${DRIVER_NAME}'`);

  const model = fields[0].trim();
  const firmware = `${fields[1]} ${fields[2]} ${fields[3]}`.trim();
  const serialNumber = fields[6].trim();
  const fmSerial = fields[7].trim();

  if (autoDetect) {
    if (serialNumber.length !== 8) throw new InvalidDeviceInfoException(`serial number must be 8 characters for '${DRIVER_NAME}'`);
    if (!SERIAL_NUMBER_PREFIXES.some(p => serialNumber.startsWith(p))) {
      throw new InvalidDeviceInfoException(`Serial ${serialNumber} must start with DT or DA for ${DRIVER_NAME}`);
    }
    if (!model.endsWith('X') && !model.endsWith('XR') && !model.endsWith('XE')) {
      throw new InvalidDeviceInfoException(`incompatible with '${DRIVER_NAME}'`);
    }
  }

  const printColumns = getPrintColumnsOfModel(model);
  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.Manufacturer = 'Datecs';
  info.Model = model;
  info.FirmwareVersion = firmware;
  info.CommentTextMaxLength = printColumns - 2;
  info.ItemTextMaxLength = 72;
  info.OperatorPasswordMaxLength = 8;
  info.SupportPaymentTerminal = true;
  return info;
}

