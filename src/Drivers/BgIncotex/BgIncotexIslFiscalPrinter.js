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

const SERIAL_NUMBER_PREFIX = 'IN';
const DRIVER_NAME = 'bg.in.isl';

const INCOTEX_CMD_ABORT_FISCAL_RECEIPT = 0x82;

export class BgIncotexIslFiscalPrinter extends BgIslFiscalPrinter {
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

  _formatOpenReceipt(receipt) {
    const op = receipt.Operator || '1';
    const usn = receipt.UniqueSaleNumber || '';
    return `${op},${usn},0`;
  }

  _formatOpenReversalReceipt(reversalReceipt) {
    const op = reversalReceipt.Operator || '1';
    const usn = reversalReceipt.UniqueSaleNumber || '';
    const receiptNum = reversalReceipt.ReceiptNumber || '';
    const fmSerial = reversalReceipt.FiscalMemorySerialNumber || '';
    const reason = this._getIncotexReversalReason(reversalReceipt.Reason);
    const dtStr = reversalReceipt.ReceiptDateTime
      ? this._formatDateForReversal(reversalReceipt.ReceiptDateTime) : '';
    // Incotex double-appends reason letter
    return `${op},${usn},${reason}${reason},${fmSerial},${receiptNum},${dtStr}`;
  }

  _getIncotexReversalReason(reason) {
    switch (reason) {
      case ReversalReason.OperatorError: return 'R';
      case ReversalReason.Refund: return 'S';
      case ReversalReason.TaxBaseReduction: return 'V';
      case 'taxbase-reduction': return 'V';
      default: return 'R';
    }
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

    if (item.PriceModifierType) {
      await this._applyPriceModifier(item);
    }
  }

  async _addComment(text) {
    const lines = wrapAtLength(text, this.info.CommentTextMaxLength || 36);
    for (const line of lines) {
      await this._sendCommand(CMD.FiscalReceiptComment, line);
    }
  }

  async reset(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(INCOTEX_CMD_ABORT_FISCAL_RECEIPT, null);
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

export class BgIncotexIslFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() {
    return DRIVER_NAME;
  }

  async connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgIncotexIslFiscalPrinter(channel, serviceOptions, options);
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
  // Incotex: 7 comma-separated fields
  const fields = rawDeviceInfo.split(',');
  if (fields.length < 7) throw new InvalidDeviceInfoException(`Cannot parse Incotex device info: ${rawDeviceInfo}`);

  const serialNumber = fields[0].trim();
  const fmSerial = fields[5].trim();
  const manufacturer = fields[2].trim();
  const model = fields[3].trim();
  const firmware = fields[4].trim();
  const taxId = fields[1].trim();

  if (autoDetect && !serialNumber.startsWith(SERIAL_NUMBER_PREFIX)) {
    throw new InvalidDeviceInfoException(`Serial ${serialNumber} must start with ${SERIAL_NUMBER_PREFIX} for ${DRIVER_NAME}`);
  }

  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.Manufacturer = manufacturer || 'Incotex';
  info.Model = model;
  info.FirmwareVersion = firmware;
  info.TaxIdentificationNumber = taxId;
  info.CommentTextMaxLength = 46;
  info.ItemTextMaxLength = 36;
  info.OperatorPasswordMaxLength = 6;
  return info;
}

