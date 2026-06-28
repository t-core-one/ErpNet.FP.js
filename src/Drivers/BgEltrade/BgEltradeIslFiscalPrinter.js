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
import { ReversalReason } from '../../Core/ReversalReceipt.js';
import { withMaxLength, wrapAtLength } from '../../Helpers/Helpers.js';

const SERIAL_NUMBER_PREFIX = 'ED';
const DRIVER_NAME = 'bg.ed.isl';

const ELTRADE_CMD_OPEN_FISCAL_RECEIPT = 0x90;

export class BgEltradeIslFiscalPrinter extends BgIslFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);

    this.paymentTypeMappings = {
      [PaymentType.Cash]: 'P',
      [PaymentType.Check]: 'N',
      [PaymentType.Coupons]: 'C',
      [PaymentType.ExtCoupons]: 'D',
      [PaymentType.Packaging]: 'I',
      [PaymentType.InternalUsage]: 'J',
      [PaymentType.Damage]: 'K',
      [PaymentType.Card]: 'L',
      [PaymentType.Bank]: 'M',
      [PaymentType.Reserved1]: 'Q',
      [PaymentType.Reserved2]: 'R',
    };
  }

  getDefaultOptions() {
    return {
      'Operator.ID': '1',
      'Operator.Password': '0000',
    };
  }

  _formatOpenReceipt(receipt) {
    // Eltrade uses operator name, not ID
    const op = receipt.Operator || 'Оператор';
    const pass = receipt.OperatorPassword || '';
    const usn = receipt.UniqueSaleNumber || '';
    return `${op},${pass},${usn}`;
  }

  _formatOpenReversalReceipt(reversalReceipt) {
    const op = reversalReceipt.Operator || 'Оператор';
    const pass = reversalReceipt.OperatorPassword || '';
    const usn = reversalReceipt.UniqueSaleNumber || '';
    const receiptNum = reversalReceipt.ReceiptNumber || '';
    const fmSerial = reversalReceipt.FiscalMemorySerialNumber || '';
    const reason = this.getEltradeReversalReason(reversalReceipt.Reason);
    const dtStr = reversalReceipt.ReceiptDateTime
      ? this._formatDateForReversal(reversalReceipt.ReceiptDateTime) : '';
    return `${op},${usn},S,${fmSerial},${reason},${receiptNum},${dtStr}`;
  }

  getEltradeReversalReason(reason) {
    switch (reason) {
      case ReversalReason.OperatorError: return '1';
      case ReversalReason.Refund: return '0';
      case ReversalReason.TaxBaseReduction: return '2';
      case 'taxbase-reduction': return '2';
      default: return '1';
    }
  }

  async _openReceipt(receipt) {
    await this._sendCommand(ELTRADE_CMD_OPEN_FISCAL_RECEIPT, this._formatOpenReceipt(receipt));
  }

  async _openReversalReceipt(reversalReceipt) {
    await this._sendCommand(ELTRADE_CMD_OPEN_FISCAL_RECEIPT, this._formatOpenReversalReceipt(reversalReceipt));
  }

  async printMoneyDeposit(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithCashAmount();
    try {
      const amount = transferAmount.Amount.toFixed(2);
      await this._sendCommand(CMD.MoneyTransfer, `P,+${amount}`);
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
      await this._sendCommand(CMD.MoneyTransfer, `P,-${amount}`);
      status.Amount = transferAmount.Amount;
    } catch (e) {
      status.addError('E300', e.message);
    }
    return status;
  }
}

export class BgEltradeIslFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() {
    return DRIVER_NAME;
  }

  async connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgEltradeIslFiscalPrinter(channel, serviceOptions, options);
    const cacheKey = `isl.${channel.descriptor}.${DRIVER_NAME}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      printer.info = parseDeviceInfo(cached, autoDetect);
      printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
      if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
      return printer;
    }

    const rawDeviceInfo = await printer.getRawDeviceInfo();
    this.cache.store(cacheKey, rawDeviceInfo, 30000);
    printer.info = parseDeviceInfo(rawDeviceInfo, autoDetect);
    printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
    printer.info.SupportsSubTotalAmountModifiers = false;
    if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
    return printer;
  }
}

function parseDeviceInfo(rawDeviceInfo, autoDetect) {
  // Eltrade: 7 comma-separated fields
  const fields = rawDeviceInfo.split(',');
  if (fields.length < 7) throw new InvalidDeviceInfoException(`Cannot parse Eltrade device info: ${rawDeviceInfo}`);

  const serialNumber = fields[0].trim();
  const fmSerial = fields[1].trim();
  const manufacturer = fields[2].trim();
  const model = fields[3].trim();
  const firmware = fields[4].trim();
  const taxId = fields[5].trim();
  const printColumns = parseInt(fields[6], 10) || 48;

  if (autoDetect && !serialNumber.startsWith(SERIAL_NUMBER_PREFIX)) {
    throw new InvalidDeviceInfoException(`Serial ${serialNumber} must start with ${SERIAL_NUMBER_PREFIX} for ${DRIVER_NAME}`);
  }

  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.Manufacturer = manufacturer || 'Eltrade';
  info.Model = model;
  info.FirmwareVersion = firmware;
  info.TaxIdentificationNumber = taxId;
  info.CommentTextMaxLength = printColumns - 2;
  info.ItemTextMaxLength = printColumns - 10;
  info.OperatorPasswordMaxLength = 6;
  return info;
}

