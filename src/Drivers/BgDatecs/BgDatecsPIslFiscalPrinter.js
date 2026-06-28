import iconv from 'iconv-lite';
import { BgIslFiscalPrinter, CMD } from '../BgIslFiscalPrinter.js';
import { DeviceInfo } from '../../Core/DeviceInfo.js';
import { FiscalPrinterDriver } from '../../Core/FiscalPrinterDriver.js';
import { InvalidDeviceInfoException } from '../../Exceptions/InvalidDeviceInfoException.js';
import { ItemType, PriceModifierType, TaxGroup } from '../../Core/Item.js';
import { PaymentType } from '../../Core/Payment.js';
import { withMaxLength } from '../../Helpers/Helpers.js';

const SERIAL_NUMBER_PREFIXES = ['DT', 'DA'];
const DRIVER_NAME = 'bg.dt.p.isl';
const CMD_OPEN_REVERSAL = 0x2E;

export class BgDatecsPIslFiscalPrinter extends BgIslFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this.info.CommentTextMaxLength = 46;
    this.info.ItemTextMaxLength = 34;
    this.info.OperatorPasswordMaxLength = 8;

    this.paymentTypeMappings = {
      [PaymentType.Cash]:          'P',
      [PaymentType.Check]:         'C',
      [PaymentType.Coupons]:       'm',
      [PaymentType.ExtCoupons]:    'n',
      [PaymentType.Packaging]:     'o',
      [PaymentType.InternalUsage]: 'p',
      [PaymentType.Damage]:        'q',
      [PaymentType.Card]:          'D',
      [PaymentType.Bank]:          'r',
      [PaymentType.Reserved1]:     'I',
      [PaymentType.Reserved2]:     'L',
    };
  }

  getDefaultOptions() {
    return {
      'Operator.ID': '1',
      'Operator.Password': '0000',
    };
  }

  // Protocol: {OpNum},{Password},1,{UniqueSaleNumber}
  _formatOpenReceipt(receipt) {
    const op = receipt.Operator || '1';
    const pass = receipt.OperatorPassword || '0000';
    const usn = receipt.UniqueSaleNumber || '';
    return `${op},${pass},1,${usn}`;
  }

  getReversalReasonText(reason) {
    switch (reason) {
      case 1 /* OperatorError */: return 'E';
      case 2 /* Refund */: return 'R';
      case 3 /* TaxBaseReduction */: return 'T';
      default: return 'E';
    }
  }

  // Protocol: [text]\t[taxCd][price][*qty][,pct|;abs]
  async _addSale(item) {
    const taxText = this.getTaxGroupText(item.TaxGroup || TaxGroup.TaxGroup1);
    const text = withMaxLength(item.Text || '', this.info.ItemTextMaxLength || 34);
    const price = (item.UnitPrice || 0).toFixed(2);
    const dept = item.Department || 0;
    const qty = item.Quantity || 0;

    let str = dept <= 0
      ? `${text}\t${taxText}${price}`
      : `${text}\t${dept}\t${price}`;
    if (qty !== 0) str += `*${qty}`;
    if (item.PriceModifierType !== PriceModifierType.None) {
      const val = item.PriceModifierValue || 0;
      switch (item.PriceModifierType) {
        case PriceModifierType.DiscountPercent:  str += `,${(-val).toFixed(2)}`; break;
        case PriceModifierType.DiscountAmount:   str += `;${(-val).toFixed(2)}`; break;
        case PriceModifierType.SurchargePercent: str += `,${val.toFixed(2)}`; break;
        case PriceModifierType.SurchargeAmount:  str += `;${val.toFixed(2)}`; break;
      }
    }
    await this._sendCommand(CMD.FiscalReceiptSale, str);
  }

  // Protocol: {OpNum},{Password},1,{ReasonCode}{OrigDocNum},{UniqueSaleNumber},{ddMMyyHHmmss},{FMSerial}
  async _openReversalReceipt(reversalReceipt) {
    const op = reversalReceipt.Operator || '1';
    const pass = reversalReceipt.OperatorPassword || '0000';
    const usn = reversalReceipt.UniqueSaleNumber || '';
    const receiptNum = reversalReceipt.ReceiptNumber || '';
    const fmSerial = reversalReceipt.FiscalMemorySerialNumber || '';
    const reason = this.getReversalReasonText(reversalReceipt.Reason);
    const dt = reversalReceipt.ReceiptDateTime || new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const yr2 = String(dt.getFullYear()).slice(-2);
    const dtStr = `${pad2(dt.getDate())}${pad2(dt.getMonth() + 1)}${yr2}${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
    const header = `${op},${pass},1,${reason}${receiptNum},${usn},${dtStr},${fmSerial}`;
    await this._sendCommand(CMD_OPEN_REVERSAL, header);
  }
}

export class BgDatecsPIslFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() {
    return DRIVER_NAME;
  }

  async connect(channel, serviceOptions, autoDetect = true, options = null) {
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
  // Response: Model,Firmware,Flags1,Flags2,SerialNumber,FMSerial  (6 comma-separated fields)
  const fields = rawDeviceInfo.split(',');
  if (fields.length !== 6) throw new InvalidDeviceInfoException(`rawDeviceInfo must contain 6 comma-separated items for '${DRIVER_NAME}'`);

  const model = fields[0].trim();
  const firmware = fields[1].trim();
  const serialNumber = fields[4].trim();
  const fmSerial = fields[5].trim();

  if (autoDetect) {
    if (serialNumber.length !== 8) throw new InvalidDeviceInfoException(`serial number must be 8 characters for '${DRIVER_NAME}'`);
    if (!SERIAL_NUMBER_PREFIXES.some(p => serialNumber.startsWith(p))) {
      throw new InvalidDeviceInfoException(`Serial ${serialNumber} must start with DT or DA for ${DRIVER_NAME}`);
    }
    if (model.endsWith('X') || model.endsWith('XR') || model.endsWith('XE')) {
      throw new InvalidDeviceInfoException(`incompatible with '${DRIVER_NAME}'`);
    }
    if (!model.startsWith('FP') && !model.startsWith('FMP') && !model.startsWith('SK')) {
      throw new InvalidDeviceInfoException(`incompatible with '${DRIVER_NAME}'`);
    }
  }

  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.Manufacturer = 'Datecs';
  info.Model = model;
  info.FirmwareVersion = firmware;
  info.CommentTextMaxLength = 46;
  info.ItemTextMaxLength = 34;
  info.OperatorPasswordMaxLength = 8;
  return info;
}

