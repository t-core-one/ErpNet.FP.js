import iconv from 'iconv-lite';
import logger from '../../logger.js';
import { BgIslFiscalPrinter, CMD } from '../BgIslFiscalPrinter.js';
import { DeviceInfo } from '../../Core/DeviceInfo.js';
import { FiscalPrinterDriver } from '../../Core/FiscalPrinterDriver.js';
import { InvalidDeviceInfoException } from '../../Exceptions/InvalidDeviceInfoException.js';
import { StandardizedStatusMessageException } from '../../Exceptions/StandardizedStatusMessageException.js';
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

/**
 * Status bits for the X series, indexed as byteIndex * 8 + bitIndex.
 *
 * The X protocol reports EIGHT status bytes where the older dialect reports six,
 * and the meanings are not the same, so decoding an X reply with the base table
 * silently mislabels the device's condition. Bit 7 of each byte is a marker and
 * lands on a reserved (empty) entry here rather than being masked off, which is
 * how upstream handles it too.
 *
 * Only entries that mean something are listed; everything else is reserved.
 * Ported from upstream ErpNet.FP BgDatecsXIslFiscalPrinter.Commands.cs.
 */
const X_STATUS_BITS = {
  0:  ['E401', 'Syntax error', 'error'],
  1:  ['E402', 'Command code is invalid', 'error'],
  2:  ['E103', 'The real time clock is not synchronized', 'error'],
  4:  ['E303', 'Failure in printing mechanism', 'error'],
  5:  ['E199', 'General error', 'error'],
  6:  ['E302', 'Cover is open', 'error'],

  8:  ['E403', 'Overflow during command execution', 'error'],
  9:  ['E404', 'Command is not permitted', 'error'],

  16: ['E301', 'End of paper', 'error'],
  17: ['W301', 'Near paper end', 'warning'],
  18: ['E206', 'EJ is full', 'error'],
  19: [null, 'Fiscal receipt is open', 'info'],
  20: ['W202', 'EJ nearly full', 'warning'],
  21: [null, 'Nonfiscal receipt is open', 'info'],

  32: ['E203', 'Error when trying to access data stored in the FM', 'error'],
  33: [null, 'Tax number is set', 'info'],
  34: [null, 'Serial number and number of FM are set', 'info'],
  35: ['W201', 'There is space for less then 60 reports in Fiscal memory', 'warning'],
  36: ['E201', 'FM full', 'error'],
  37: ['E299', 'FM general error', 'error'],
  38: ['E205', 'Fiscal memory is not found or damaged', 'error'],

  41: [null, 'FM is formatted', 'info'],
  43: [null, 'Device is fiscalized', 'info'],
  44: [null, 'VAT are set at least once', 'info'],
};

/** Each hex nibble + 0x30, so 0xB becomes 0x3B. Not ASCII hex. */
function uint16To4Bytes(word) {
  return Buffer.from([
    ((word >> 12) & 0x0f) + 0x30,
    ((word >> 8) & 0x0f) + 0x30,
    ((word >> 4) & 0x0f) + 0x30,
    (word & 0x0f) + 0x30,
  ]);
}

export class BgDatecsXIslFiscalPrinter extends BgIslFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this.info.SupportPaymentTerminal = true;

    // This family's LEN and CMD are four bytes each, not one, so the payload
    // starts ten bytes past the preamble instead of four.
    this.responseHeaderLength = 10;

    this.paymentTypeMappings = {
      [PaymentType.Cash]: '0',
      [PaymentType.Check]: '3',
      [PaymentType.Coupons]: '5',
      [PaymentType.ExtCoupons]: '4',
      [PaymentType.Card]: '1',
    };
  }


  /**
   * The X series frame, which is NOT the frame the rest of the ISL family uses.
   *
   * Two header fields widen from one byte to four — LEN and CMD — each written
   * as UInt16To4Bytes (hex nibble + 0x30). Everything else is identical to the
   * base: preamble, one-byte SEQ, raw CP1251 data, postamble, a four-byte BCC
   * over every byte after the preamble through the postamble, and terminator.
   *
   * Without this override the port sends the older one-byte-header frame to an
   * X device. The device answers SYN then NAK to every command — a checksum and
   * format complaint, not a refusal — so nothing is detected and every driver
   * simply times out. The symptom is indistinguishable from an unplugged or
   * silent printer, which is what made it expensive to find.
   *
   * Ported from upstream ErpNet.FP BgDatecsXIslFiscalPrinter.Frame.cs. Covers
   * FP-700X, FP-700XR, DP-25X, DP-05C, WP-500X, WP-50X, FMP-350X and FMP-55X.
   */
  _buildHostFrame(seq, cmd, data) {
    const payload = data || Buffer.alloc(0);
    const body = Buffer.concat([
      uint16To4Bytes(0x20 + 10 + payload.length),
      Buffer.from([seq]),
      uint16To4Bytes(cmd),
      payload,
      Buffer.from([0x05]),
    ]);
    let bcc = 0;
    for (const b of body) bcc += b;
    return Buffer.concat([
      Buffer.from([0x01]),
      body,
      uint16To4Bytes(bcc & 0xffff),
      Buffer.from([0x03]),
    ]);
  }

  /**
   * Decode the eight X status bytes. Only errors are returned, because the
   * caller treats a non-empty result as a rejection — the informational bits a
   * healthy device always sets (fiscalized, FM formatted, VAT set) must never
   * reach it, or every command would look like a failure.
   */
  describeStatusErrors(statusBytes) {
    const errors = [];
    for (let i = 0; i < statusBytes.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        if (!(statusBytes[i] & (1 << bit))) continue;
        const entry = X_STATUS_BITS[i * 8 + bit];
        if (entry && entry[2] === 'error') {
          errors.push(entry[0] ? `${entry[0]} ${entry[1]}` : entry[1]);
        }
      }
    }
    return errors;
  }

  /**
   * Receipt total, read from 0x4C "T".
   *
   * This family answers tab-separated —
   * `<code>\t<isOpen>\t<docNumber>\t<items>\t<total>\t<paid>\t` — while the base
   * parser splits on commas and reads field 2. On an X device that never matches,
   * so the base silently returned 0 and _assertReceiptSettled treated it as
   * "nothing trustworthy to compare against" and skipped the check entirely. The
   * guard that exists to stop an underpaid receipt being abandoned half-printed
   * was therefore inert on exactly the family whose failures are hardest to see.
   */
  async _getReceiptAmount() {
    try {
      const resp = await this._sendCommand(CMD.GetReceiptStatus, 'T');
      const fields = iconv.decode(resp || Buffer.alloc(0), 'cp1251').split('\t');
      if (fields.length >= 5) {
        const total = parseFloat(fields[4].trim());
        return Number.isFinite(total) ? total : 0;
      }
    } catch (_) { /* never fail a good receipt because the probe failed */ }
    return 0;
  }

  /**
   * Tax groups are DIGITS on the X series, not the Cyrillic letters the rest of
   * the ISL family uses. Sending "Б" where the device wants "2" is rejected with
   * -111005, and because that code arrives in the response DATA while the status
   * bytes stay healthy, the base driver saw a success: the receipt opened, every
   * sale line was silently refused, and the close then failed because the receipt
   * was empty. The paper showed a receipt that started and never finished.
   */
  getTaxGroupText(taxGroup) {
    const map = {
      [TaxGroup.TaxGroup1]: '1',
      [TaxGroup.TaxGroup2]: '2',
      [TaxGroup.TaxGroup3]: '3',
      [TaxGroup.TaxGroup4]: '4',
      [TaxGroup.TaxGroup5]: '5',
      [TaxGroup.TaxGroup6]: '6',
      [TaxGroup.TaxGroup7]: '7',
      [TaxGroup.TaxGroup8]: '8',
    };
    return map[taxGroup] || map[TaxGroup.TaxGroup1];
  }

  /**
   * Treat a negative code in field 0 of the response as a rejection.
   *
   * This family reports the COMMAND's outcome in the response data and the
   * PRINTER's condition in the status bytes. The base driver only reads the
   * status bytes, so a refused command looked like a success — the failure only
   * surfaced later, as a receipt that would not close, by which point a document
   * was already open on the device and the POS had been told the sale worked.
   *
   * Only a leading field of the form -NNNN is treated as an error: some commands
   * (GetDeviceInfo among them) answer with data that has no result code at all.
   */
  async _sendCommand(cmd, data, retries, timeoutMs) {
    const resp = await super._sendCommand(cmd, data, retries, timeoutMs);
    const first = iconv.decode(resp || Buffer.alloc(0), 'cp1251').split('\t')[0].trim();
    if (/^-\d+$/.test(first)) {
      const rejection = new StandardizedStatusMessageException(
        `Device rejected command 0x${cmd.toString(16)} with error code ${first}`
      );
      rejection.responseData = resp;
      rejection.command = cmd;
      throw rejection;
    }
    return resp;
  }

  getDefaultOptions() {
    return {
      'Operator.ID': '1',
      'Operator.Password': '0000',
    };
  }

  /**
   * Closing a receipt on the X series answers with the printer's CONDITION in
   * the status bytes and the command's OUTCOME in the data — in the same frame.
   * Paper running out as the receipt closes therefore raises a status error for
   * a command that actually succeeded: the receipt is already in fiscal memory.
   *
   * Treating that as a failure is the expensive mistake. The POS would report
   * the sale as unfiscalised and a retry would issue a SECOND fiscal receipt
   * for one sale — a real fiscal document that has to be reversed by hand.
   *
   * Error code 0 plus a document number means it landed, so the rejection is
   * swallowed. Anything else propagates untouched.
   *
   * Ported from upstream ErpNet.FP c7bbf80 (PR #209).
   */
  async _closeReceipt() {
    try {
      return await super._closeReceipt();
    } catch (e) {
      if (!e || !e.responseData) {
        throw e;
      }
      const decoded = iconv.decode(e.responseData, 'cp1251');
      const fields = decoded.split('\t');
      if (fields.length >= 2 && fields[0].trim() === '0' && fields[1].trim() !== '') {
        logger.warn(
          `CloseReceipt reported a printer condition but the receipt is in fiscal memory `
          + `(document ${fields[1].trim()}); treating as success: ${e.message}`
        );
        // Hand back the response: it carries the document number, and on this
        // family there is no other way to read it.
        return decoded;
      }
      throw e;
    }
  }

  /**
   * The X series rejects GetLastDocumentNumber (0x71) with E402 "command code is
   * invalid" — verified on an FP-700X, firmware 3.00. The number is field 1 of
   * the close-receipt response instead.
   *
   * When this was left to the base implementation the receipt printed and closed
   * correctly and only the follow-up 0x71 failed, so the POS reported the sale as
   * failed while a valid fiscal document existed on paper and in fiscal memory —
   * the worst way for this to go wrong, because the two records disagree and only
   * the paper is right.
   */
  async _getLastDocumentNumber(closeResponse) {
    const fields = String(closeResponse || '').split('\t');
    if (fields.length < 2 || fields[1].trim() === '') {
      throw new StandardizedStatusMessageException(
        'E409 Wrong format of close receipt response; cannot read the document number'
      );
    }
    return fields[1].trim();
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
      modType, modVal, String(dept), ''].join('\t');
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
  info.SupportsPeriodReport = true;
  info.Manufacturer = 'Datecs';
  info.Model = model;
  info.FirmwareVersion = firmware;
  info.CommentTextMaxLength = printColumns - 2;
  info.ItemTextMaxLength = 72;
  info.OperatorPasswordMaxLength = 8;
  info.SupportPaymentTerminal = true;
  return info;
}

