import iconv from 'iconv-lite';
import { BgIslFiscalPrinter, CMD } from '../BgIslFiscalPrinter.js';
import { DeviceInfo } from '../../Core/DeviceInfo.js';
import { DeviceStatusWithCashAmount } from '../../Core/DeviceStatus.js';
import { FiscalPrinterDriver } from '../../Core/FiscalPrinterDriver.js';
import { InvalidDeviceInfoException } from '../../Exceptions/InvalidDeviceInfoException.js';
import { ItemType, PriceModifierType, TaxGroup } from '../../Core/Item.js';
import { PaymentType } from '../../Core/Payment.js';
import { ReversalReason } from '../../Core/ReversalReceipt.js';
import { formatQuantity, withMaxLength, toDate } from '../../Helpers/Helpers.js';

// Generated from upstream ErpNet.FP BgDatecsPIslFiscalPrinter.StatusBitsStrings.
// Only StatusMessageType.Error entries; byte 3 is skipped because it reports the
// DIP-switch state (SW1..SW7) rather than a fault.
const P_STATUS_ERROR_BITS = [
  [0, 0, 'E401', 'Syntax error in the received data'],
  [0, 1, 'E402', 'Invalid command code received'],
  [0, 2, 'E103', 'The clock is not set'],
  [0, 4, 'E303', 'Printing unit fault'],
  [0, 5, 'E199', 'General error'],
  [0, 6, 'E302', 'The printer cover is open'],
  [1, 0, 'E403', 'The command resulted in an overflow of some amount fields'],
  [1, 1, 'E404', 'The command is not allowed in the current fiscal mode'],
  [1, 2, 'E104', 'The RAM has been reset'],
  [1, 3, 'E102', 'Low battery (the real-time clock is in RESET status)'],
  [1, 6, 'E599', 'The built-in tax terminal is not responding'],
  [2, 0, 'E301', 'No paper'],
  [2, 2, 'E206', 'End of the EJ'],
  [4, 0, 'E202', 'Fiscal memory store error'],
  [4, 4, 'E201', 'The fiscal memory is full'],
  [4, 5, 'E299', 'FM general error'],
  [4, 6, 'E304', 'The printing head is overheated'],
  [5, 0, 'E204', 'The fiscal memory is set in READONLY mode (locked)'],
  [5, 2, 'E202', 'The last fiscal memory store operation is not successful'],
  [5, 5, 'E203', 'Fiscal memory read error'],
];

// Reported by cash() in place of a real reading — see the note there. Large
// enough that a caller's "is there enough cash?" pre-check never blocks, because
// the device performs the real check itself.
const CASH_BALANCE_UNKNOWN = 9999999;

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

  /**
   * Full FP-700 / FP-800 status table, from the device documentation via
   * upstream's ParseStatus.
   *
   * The base class checks only three bits, which is why a REFUSED command could
   * pass as success: closing a receipt that is not fully paid sets E404 ("not
   * allowed in the current fiscal mode"), and with only 3 bits watched the
   * driver returned Ok, the POS booked the sale, and the receipt stayed open —
   * corrupting that receipt and the next one.
   *
   * Verified against the healthy baseline observed on both live devices,
   * `88 80 80 ea 86 9a`, which yields no errors: bit 7 of every byte is a frame
   * marker and the remaining set bits there are informational.
   */
  describeStatusErrors(statusBytes) {
    const errors = [];
    for (const [idx, bit, code, text] of P_STATUS_ERROR_BITS) {
      if (idx < statusBytes.length && (statusBytes[idx] >> bit) & 1) {
        errors.push(`${code} ${text}`);
      }
    }
    return errors;
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
      case ReversalReason.OperatorError: return 'E';
      case ReversalReason.Refund: return 'R';
      case ReversalReason.TaxBaseReduction: return 'T';
      case 'taxbase-reduction': return 'T'; // backward compat
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
    if (qty !== 0) str += `*${formatQuantity(qty)}`;
    if (item.PriceModifierType) {
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

  /**
   * The drawer balance is NOT read from the device on this family.
   *
   * Reading it means sending MoneyTransfer (0x46), and an FP-700/FP-800 prints a
   * служебно въведени slip even for a zero amount — confirmed on the Mechka
   * FP-800, which answers "P,+000000000000,+000000000000,+000000000000" and
   * still puts paper through. The POS calls this before every withdrawal, so an
   * accurate balance would cost a stray slip each time.
   *
   * The amount below is therefore a deliberate "no known limit" placeholder, not
   * a reading, so a caller's pre-check can never block a legitimate withdrawal.
   * The real limit is still enforced one step later by the device itself:
   * printMoneyWithdraw raises E301 when the printer refuses for lack of cash.
   *
   * The warning states this, so nothing downstream mistakes the placeholder for
   * a real balance. It is a warning and not an error on purpose — DeviceStatus
   * only clears Ok for errors, and the POS throws on !ok.
   */
  async cash() {
    const status = new DeviceStatusWithCashAmount();
    status.Amount = CASH_BALANCE_UNKNOWN;
    status.addWarning(
      'W301',
      'Cash balance is not read on this device family: querying it would print a '
      + 'slip. The amount is a placeholder, not a reading — the printer enforces '
      + 'the real limit when a withdrawal is attempted.'
    );
    return status;
  }

  // Protocol: {OpNum},{Password},1,{ReasonCode}{OrigDocNum},{UniqueSaleNumber},{ddMMyyHHmmss},{FMSerial}
  async _openReversalReceipt(reversalReceipt) {
    const op = reversalReceipt.Operator || '1';
    const pass = reversalReceipt.OperatorPassword || '0000';
    const usn = reversalReceipt.UniqueSaleNumber || '';
    const receiptNum = reversalReceipt.ReceiptNumber || '';
    const fmSerial = reversalReceipt.FiscalMemorySerialNumber || '';
    const reason = this.getReversalReasonText(reversalReceipt.Reason);
    const rawDt = reversalReceipt.ReceiptDateTime;
    const dt = toDate(rawDt);
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
  info.SupportsPeriodReport = true;
  info.Manufacturer = 'Datecs';
  info.Model = model;
  info.FirmwareVersion = firmware;
  info.CommentTextMaxLength = 46;
  info.ItemTextMaxLength = 34;
  info.OperatorPasswordMaxLength = 8;
  return info;
}

