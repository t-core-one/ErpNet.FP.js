import iconv from 'iconv-lite';
import { BgFiscalPrinter } from '../BgFiscalPrinter.js';
import {
  DeviceStatusWithDateTime,
  DeviceStatusWithRawResponse,
  DeviceStatusWithCashAmount,
  DeviceStatusWithReceiptInfo,
} from '../../Core/DeviceStatus.js';
import { ItemType, PriceModifierType, TaxGroup } from '../../Core/Item.js';
import { PaymentType } from '../../Core/Payment.js';
import { withMaxLength, wrapAtLength } from '../../Helpers/Helpers.js';
import { InvalidResponseException } from '../../Exceptions/InvalidResponseException.js';
import { isDetailedPeriodReport, formatDateDDMMYY } from '../../Helpers/periodReport.js';

const STX = 0x02;
const ETX = 0x0A;
const MAX_SEQ = 0x7F;

export const CMD = {
  GetStatus:                  0x20,
  Version:                    0x21,
  OpenReceipt:                0x30,
  SellCorrection:             0x31,
  SellCorrectionDepartment:   0x34,
  Payment:                    0x35,
  FullPaymentAndClose:        0x36,
  FreeText:                   0x37,
  CloseReceipt:               0x38,
  AbortReceipt:               0x39,
  PrintLastDuplicate:         0x3A,
  NoFiscalRAorPO:             0x3B,
  Subtotal:                   0x33,
  PrintDailyReport:           0x7C,
  FMReportByDateDetailed:     0x7A,
  FMReportByDateBrief:        0x7B,
  GetDateTime:                0x68,
  SetDateTime:                0x48,
  ReadLastQR:                 0x72,
  ReadDailyAmounts:           0x6E,
  GetTaxId:                   0x61,
  ReadFDNumbers:              0x60,
};

const ITEM_TEXT_MANDATORY_LENGTH = 36;

class FrameBuilder {
  constructor() {
    this._parts = [];
  }

  addString(str, encoding = 'cp1251') {
    this._parts.push(iconv.encode(str || '', encoding));
    return this;
  }

  addByte(b) {
    this._parts.push(Buffer.from([b]));
    return this;
  }

  build() {
    return Buffer.concat(this._parts);
  }
}

/**
 * The date and time out of the last-receipt QR data.
 *
 * An FP-28 answers ISO — "2026-09-14" and "11:11:41". Only the compact
 * "DDMMYY"/"HHMMSS" shape was handled, and slicing an ISO string by position
 * yields month 25 and a NaN year, i.e. an Invalid Date. That serialises to
 * null, so the caller stored no receipt time at all — and a later storno then
 * sent an EMPTY date field to the device, which faults it. Both shapes are
 * accepted; anything else returns null rather than an Invalid Date, so a
 * missing time is detectable instead of silently poisoning a later reversal.
 */
export function parseQrDateTime(dateStr, timeStr) {
  const d = String(dateStr || '').trim();
  const t = String(timeStr || '').trim();
  let yr, mon, day;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (iso) {
    yr = +iso[1]; mon = +iso[2]; day = +iso[3];
  } else if (/^\d{6}$/.test(d)) {
    day = +d.slice(0, 2); mon = +d.slice(2, 4); yr = 2000 + +d.slice(4, 6);
  } else {
    return null;
  }
  let hh = 0, mm = 0, ss = 0;
  const colon = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (colon) {
    hh = +colon[1]; mm = +colon[2]; ss = +(colon[3] || 0);
  } else if (/^\d{6}$/.test(t)) {
    hh = +t.slice(0, 2); mm = +t.slice(2, 4); ss = +t.slice(4, 6);
  } else if (t) {
    return null;
  }
  const dt = new Date(yr, mon - 1, day, hh, mm, ss);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export class BgZfpFiscalPrinter extends BgFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this._seqNum = 0;

    this.paymentTypeMappings = {
      [PaymentType.Cash]: '0',
      [PaymentType.Check]: '1',
      [PaymentType.Coupons]: '2',
      [PaymentType.ExtCoupons]: '3',
      [PaymentType.Packaging]: '4',
      [PaymentType.InternalUsage]: '5',
      [PaymentType.Damage]: '6',
      [PaymentType.Card]: '7',
      [PaymentType.Bank]: '8',
      [PaymentType.Reserved1]: '9',
      [PaymentType.Reserved2]: '10',
    };
  }

  getTaxGroupText(taxGroup) {
    const map = {
      [TaxGroup.TaxGroup1]: 'А',
      [TaxGroup.TaxGroup2]: 'Б',
      [TaxGroup.TaxGroup3]: 'В',
      [TaxGroup.TaxGroup4]: 'Г',
      [TaxGroup.TaxGroup5]: 'Д',
      [TaxGroup.TaxGroup6]: 'Е',
      [TaxGroup.TaxGroup7]: 'Ж',
      [TaxGroup.TaxGroup8]: 'З',
    };
    return map[taxGroup] || map[TaxGroup.TaxGroup1];
  }

  _nextSeq() {
    // FrameSequenceNumber cycles 0..0x7F; SEQ byte = 0x20 + counter → range 0x20..0x9F
    this._seqNum = (this._seqNum + 1) % 0x80;
    return 0x20 + this._seqNum;
  }

  _buildHostFrame(seq, cmd, data) {
    // Frame: STX | LEN | SEQ | CMD | data | CS[2] | ETX
    // LEN = 0x20 + 3 + len(data)  (3 = SEQ + CMD + one marker — per Tremol ZFP spec)
    // CS = XOR of [LEN, SEQ, CMD, data...]
    const dataLen = data ? data.length : 0;
    const lenByte = 0x20 + 3 + dataLen;

    // Compute CS over [LEN, SEQ, CMD, data...]
    let cs = lenByte ^ seq ^ cmd;
    if (data) for (const b of data) cs ^= b;

    return Buffer.concat([
      Buffer.from([STX, lenByte, seq, cmd]),
      data || Buffer.alloc(0),
      Buffer.from([(cs >> 4) + 0x30, (cs & 0x0F) + 0x30]),
      Buffer.from([ETX]),
    ]);
  }

  /**
   * Interpret a response shape the shared parser does not know.
   *
   * Returns null here, so the framing below stays exactly what it has always
   * been for every existing ZFP device. A model-specific subclass overrides
   * this when its firmware answers in a shape the shared parser would discard
   * — see BgTremolFp28ZfpFiscalPrinter, whose FP-28 firmware replies to
   * execute-only commands with a bare ACK frame rather than a data frame.
   *
   * @returns {null|{data: Buffer}|{retry: true}} null => not handled here
   */
  _interpretResponse(response, cmd) {  // eslint-disable-line no-unused-vars
    return null;
  }

  async _sendCommand(cmd, data, retries = 3) {
    const seq = this._nextSeq();
    const frame = this._buildHostFrame(seq, cmd, data);

    for (let attempt = 0; attempt < retries; attempt++) {
      await this._channel.write(frame);

      const deadline = Date.now() + 5000;
      let response = Buffer.alloc(0);
      while (Date.now() < deadline) {
        const chunk = await this._channel.read();
        if (chunk && chunk.length > 0) {
          response = Buffer.concat([response, chunk]);
          if (response.includes(ETX)) break;
        }
        await new Promise(r => setTimeout(r, 30));
      }

      if (!response || response.length === 0) continue;

      // Model-specific shapes first; a no-op unless a subclass opts in.
      const alt = this._interpretResponse(response, cmd);
      if (alt) {
        if (alt.retry) continue;
        return alt.data;
      }

      const stxIdx = response.indexOf(STX);
      const etxIdx = response.lastIndexOf(ETX);
      if (stxIdx < 0 || etxIdx <= stxIdx) continue;

      // Data frame: STX | LEN | SEQ | CMD_ECHO | data | CS[2] | ETX
      // data starts at stxIdx+4 (after STX, LEN, SEQ, CMD_ECHO), ends before CS[2]
      const dataStart = stxIdx + 4;
      const dataEnd = etxIdx - 2;
      return dataEnd > dataStart ? response.slice(dataStart, dataEnd) : Buffer.alloc(0);
    }
    throw new InvalidResponseException('No valid ZFP response received after retries');
  }

  async getRawDeviceInfo() {
    const resp = await this._sendCommand(CMD.Version, null);
    const str = iconv.decode(resp || Buffer.alloc(0), 'cp1251');
    const taxResp = await this._sendCommand(CMD.GetTaxId, null);
    const taxStr = iconv.decode(taxResp || Buffer.alloc(0), 'cp1251');
    const fmResp = await this._sendCommand(CMD.ReadFDNumbers, null);
    const fmStr = iconv.decode(fmResp || Buffer.alloc(0), 'cp1251');
    return [str.trim(), `${taxStr.trim()};${fmStr.trim()}`];
  }

  async rawRequest(requestFrame) {
    const status = new DeviceStatusWithRawResponse();
    try {
      const raw = requestFrame.RawRequest || '';
      const parts = raw.split(';');
      const cmdCode = parseInt(parts[0], 16);
      const argStr = parts.slice(1).join(';');
      const argData = argStr ? iconv.encode(argStr, 'cp1251') : null;
      const response = await this._sendCommand(cmdCode, argData);
      status.RawResponse = iconv.decode(response || Buffer.alloc(0), 'cp1251');
    } catch (e) {
      status.addError('E999', e.message);
    }
    return status;
  }

  async checkStatus() {
    const status = new DeviceStatusWithDateTime();
    try {
      const resp = await this._sendCommand(CMD.GetDateTime, null);
      const str = iconv.decode(resp, 'cp1251').trim();
      const m = str.match(/(\d{2})-(\d{2})-(\d{2,4})\s+(\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        const year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
        status.DeviceDateTime = new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10),
          parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10));
      }
    } catch (e) {
      status.addError('E001', e.message);
    }
    return status;
  }

  async setDateTime(datetime) {
    const dt = datetime.DeviceDateTime || new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const str = `${pad2(dt.getDate())}-${pad2(dt.getMonth() + 1)}-${String(dt.getFullYear()).slice(-2)}`
      + ` ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
    const status = new DeviceStatusWithDateTime();
    try {
      await this._sendCommand(CMD.SetDateTime, iconv.encode(str, 'cp1251'));
      status.DeviceDateTime = dt;
    } catch (e) {
      status.addError('E002', e.message);
    }
    return status;
  }

  async cash() {
    const status = new DeviceStatusWithCashAmount();
    try {
      const resp = await this._sendCommand(CMD.ReadDailyAmounts, iconv.encode('0', 'cp1251'));
      const str = iconv.decode(resp, 'cp1251');
      // The device answers semicolon-separated, and the cash amount is field 1;
      // field 0 is a leading flag. Splitting on ',' left one field whose
      // parseFloat is the flag, so the drawer always read 0 — and the POS checks
      // a withdrawal against this before allowing it.
      const parts = str.split(';');
      if (parts.length < 3) {
        status.addError('E409', `Invalid cash response format: "${str.trim()}"`);
      } else {
        const amount = parts[1].trim();
        // Some firmwares answer in whole stotinki when there is no decimal point.
        status.Amount = amount.includes('.')
          ? (parseFloat(amount) || 0)
          : ((parseInt(amount, 10) || 0) / 100);
      }
    } catch (e) {
      status.addError('E003', e.message);
    }
    return status;
  }

  /**
   * Reversal validation for the Tremol family.
   *
   * The shared check looks only at the УНП, so two things got through to the
   * device: a storno with no items, which printed as a 0.00 document, and an
   * incomplete reference to the original receipt, which faults an FP-28. The
   * reference implementation folds the full receipt checks in here and drops
   * the payments; this override does the same.
   *
   * It lives on the ZFP base rather than on BgFiscalPrinter because every other
   * vendor sits on that base and none of this is verified against their
   * hardware.
   */
  validateReversalReceipt(reversalReceipt) {
    const status = super.validateReversalReceipt(reversalReceipt);
    if (!reversalReceipt || !status.Ok) {
      return status;
    }
    if (!reversalReceipt.Items || reversalReceipt.Items.length === 0) {
      status.addError('E210', 'Reversal receipt must have at least one item');
    }
    if (!reversalReceipt.ReceiptNumber) {
      status.addError('E405', 'ReceiptNumber of the original receipt is empty');
    }
    if (!reversalReceipt.FiscalMemorySerialNumber) {
      status.addError('E405', 'FiscalMemorySerialNumber of the original receipt is empty');
    }
    // The device reverses the original amounts itself; a payments array here is
    // ignored by the protocol, so drop it rather than send lines that mean
    // nothing. Warn so a caller sending them can see why they vanished.
    if (reversalReceipt.Payments && reversalReceipt.Payments.length) {
      status.addWarning('W302',
        'Reversal payments are ignored by the device and have been dropped.');
      reversalReceipt.Payments = [];
    }
    return status;
  }

  _formatDateTimeForReceipt(dt) {
    const pad2 = n => String(n).padStart(2, '0');
    return `${pad2(dt.getDate())}${pad2(dt.getMonth() + 1)}${String(dt.getFullYear()).slice(-2)}${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
  }

  /** "DD-MM-YY HH:MM:SS" — the form the reversal header wants. */
  _formatReversalDateTime(dt) {
    const pad2 = n => String(n).padStart(2, '0');
    return `${pad2(dt.getDate())}-${pad2(dt.getMonth() + 1)}-${String(dt.getFullYear()).slice(-2)}`
      + ` ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
  }

  async _openReceipt(receipt, isReversal = false, reversalReceipt = null) {
    const op = receipt.Operator || '1';
    const pass = receipt.OperatorPassword || '0000';
    const usn = receipt.UniqueSaleNumber || '';
    let fields;
    if (isReversal && reversalReceipt) {
      // Refuse an incomplete reference instead of sending the device an empty
      // field where the protocol wants a fixed shape. An empty date here is not
      // a soft error on an FP-28 — the firmware faults and the device restarts
      // mid-transaction, so this has to be caught before anything is written.
      const missing = [];
      if (!reversalReceipt.ReceiptNumber) missing.push('receiptNumber');
      if (!reversalReceipt.FiscalMemorySerialNumber) missing.push('fiscalMemorySerialNumber');
      const refDate = reversalReceipt.ReceiptDateTime
        ? new Date(reversalReceipt.ReceiptDateTime) : null;
      if (!refDate || Number.isNaN(refDate.getTime())) missing.push('receiptDateTime');
      if (missing.length) {
        throw new InvalidResponseException(
          'Cannot storno without a complete reference to the original receipt: '
          + `missing ${missing.join(', ')}. The device faults on an incomplete `
          + 'reversal header, so nothing was sent to it.'
        );
      }
      // <OperNum>;<OperPass>;<ReceiptFormat>;<PrintVAT>;<StornoRcpPrintType>;
      // <StornoReason>;<RelatedToRcpNum>;<RelatedToRcpDateTime "DD-MM-YY HH:MM:SS">;
      // <FMNum>{;<RelatedToURN>}
      const dt = this._formatReversalDateTime(refDate);
      fields = [op, pass, '1', '1', 'D',
        this.getReversalReasonText(reversalReceipt.Reason),
        reversalReceipt.ReceiptNumber || '',
        dt,
        reversalReceipt.FiscalMemorySerialNumber || '',
        usn];
    } else {
      // <OperNum>;<OperPass>;<ReceiptFormat>;<PrintVAT>;<FiscalRcpPrintType>{'$'<URN>}
      // '1' detailed, '1' include VAT, '2' postponed printing, '$' delimits the УНП.
      fields = [op, pass, '1', '1', `2$${usn}`];
    }
    await this._sendCommand(CMD.OpenReceipt, iconv.encode(fields.join(';'), 'cp1251'));
  }

  /** The ',' / ':' suffix carrying an item's discount or surcharge, or ''. */
  _priceModifierSuffix(item) {
    const val = item.PriceModifierValue || 0;
    switch (item.PriceModifierType) {
      case PriceModifierType.DiscountPercent:  return `,${(-val).toFixed(2)}`;
      case PriceModifierType.DiscountAmount:   return `:${(-val).toFixed(2)}`;
      case PriceModifierType.SurchargePercent: return `,${val.toFixed(2)}`;
      case PriceModifierType.SurchargeAmount:  return `:${val.toFixed(2)}`;
      default: return '';
    }
  }

  async _addItem(item) {
    // <NamePLU[36]>;<VATClass|DepNum>;<Price>{'*'<Quantity>}{','<DiscAddP>}{':'<DiscAddV>}
    // The name is truncated to what the device prints, then padded to the
    // mandatory 36 — a short name is a syntax error, not a short line.
    const text = withMaxLength(item.Text || '', this.info.ItemTextMaxLength || ITEM_TEXT_MANDATORY_LENGTH);
    const paddedText = text.padEnd(ITEM_TEXT_MANDATORY_LENGTH, ' ');
    const price = (item.UnitPrice || 0).toFixed(2);
    const dept = item.Department || 0;
    const qty = item.Quantity || 0;
    const tail = (qty ? `*${qty}` : '') + this._priceModifierSuffix(item);

    const fb = new FrameBuilder();
    fb.addString(`${paddedText};`);
    if (dept > 0) {
      // DepNum is one raw byte = dept + 0x80 (Dep01=0x81 ... Dep19=0x93), which
      // cannot round-trip through CP1251 text encoding.
      fb.addByte(0x80 + dept);
    } else {
      fb.addByte(iconv.encode(this.getTaxGroupText(item.TaxGroup || TaxGroup.TaxGroup1), 'cp1251')[0]);
    }
    fb.addString(`;${price}${tail}`);
    await this._sendCommand(dept > 0 ? CMD.SellCorrectionDepartment : CMD.SellCorrection, fb.build());
  }

  /** Discount or surcharge on the running subtotal (negative = discount). */
  async _addSubtotalChangeAmount(amount) {
    // <OptionPrinting>;<OptionDisplay>{':'<DiscAddV>}{','<DiscAddP>}
    await this._sendCommand(CMD.Subtotal, iconv.encode(`1;0:${amount.toFixed(2)}`, 'cp1251'));
  }

  async _addComment(text) {
    for (const line of wrapAtLength(text, this.info.CommentTextMaxLength || 30)) {
      await this._sendCommand(CMD.FreeText, iconv.encode(line, 'cp1251'));
    }
  }

  async _addPayment(payment) {
    // <PaymentType>;<OptionChange>;<Amount>{;<OptionChangeType>} — '1' is "no change".
    const str = `${this.getPaymentTypeText(payment.PaymentType)};1;${(payment.Amount || 0).toFixed(2)}*`;
    await this._sendCommand(CMD.Payment, iconv.encode(str, 'cp1251'));
  }

  async _getLastReceiptInfo() {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      const resp = await this._sendCommand(CMD.ReadLastQR, iconv.encode('B', 'cp1251'));
      const qr = iconv.decode(resp, 'cp1251').trim();
      const parts = qr.split('*');
      if (parts.length >= 4) {
        status.FiscalMemorySerialNumber = parts[0];
        status.ReceiptNumber = parts[1];
        status.ReceiptDateTime = parseQrDateTime(parts[2], parts[3]);
        if (parts.length >= 5) status.ReceiptAmount = parseFloat(parts[4]) || 0;
      }
    } catch (e) {
      status.addError('E010', e.message);
    }
    return status;
  }

  async printReceipt(receipt) {
    const validation = this.validateReceipt(receipt);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._openReceipt(receipt, false);
      for (const item of receipt.Items) {
        if (item.Type === ItemType.Comment || item.Type === ItemType.FooterComment) {
          await this._addComment(item.Text);
        } else if (item.Type === ItemType.DiscountAmount) {
          await this._addSubtotalChangeAmount(-(item.Amount || 0));
        } else if (item.Type === ItemType.SurchargeAmount) {
          await this._addSubtotalChangeAmount(item.Amount || 0);
        } else {
          await this._addItem(item);
        }
      }
      for (const payment of receipt.Payments) await this._addPayment(payment);
      await this._sendCommand(CMD.CloseReceipt, null);
      Object.assign(status, await this._getLastReceiptInfo());
    } catch (e) {
      status.addError('E100', e.message);
      try { await this._sendCommand(CMD.AbortReceipt, null); } catch (_) {}
    }
    return status;
  }

  async printReversalReceipt(reversalReceipt) {
    const validation = this.validateReversalReceipt(reversalReceipt);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._openReceipt(reversalReceipt, true, reversalReceipt);
      for (const item of (reversalReceipt.Items || [])) {
        if (item.Type === ItemType.Comment || item.Type === ItemType.FooterComment) {
          await this._addComment(item.Text);
        } else if (item.Type === ItemType.DiscountAmount) {
          await this._addSubtotalChangeAmount(-(item.Amount || 0));
        } else if (item.Type === ItemType.SurchargeAmount) {
          await this._addSubtotalChangeAmount(item.Amount || 0);
        } else {
          await this._addItem(item);
        }
      }
      for (const payment of (reversalReceipt.Payments || [])) await this._addPayment(payment);
      await this._sendCommand(CMD.CloseReceipt, null);
      Object.assign(status, await this._getLastReceiptInfo());
    } catch (e) {
      status.addError('E200', e.message);
      try { await this._sendCommand(CMD.AbortReceipt, null); } catch (_) {}
    }
    return status;
  }

  /**
   * Non-fiscal cash in/out. This is its own command (0x3B), not a payment line:
   * routing it through Payment (0x35) only makes sense inside an open receipt,
   * so cash movements never reached the drawer.
   */
  async _moneyTransfer(transferAmount, signedAmount) {
    const op = transferAmount.Operator || '1';
    const pass = transferAmount.OperatorPassword || '0000';
    // <OperNum>;<OperPass>;<Reserved>;<Amount>
    const str = `${op};${pass};0;${signedAmount.toFixed(2)}`;
    await this._sendCommand(CMD.NoFiscalRAorPO, iconv.encode(str, 'cp1251'));
  }

  async printMoneyDeposit(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithCashAmount();
    try {
      await this._moneyTransfer(transferAmount, transferAmount.Amount);
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
      await this._moneyTransfer(transferAmount, -transferAmount.Amount);
      status.Amount = transferAmount.Amount;
    } catch (e) {
      status.addError('E300', e.message);
    }
    return status;
  }

  async printZReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try { await this._sendCommand(CMD.PrintDailyReport, iconv.encode('Z', 'cp1251')); }
    catch (e) { status.addError('E400', e.message); }
    return status;
  }

  /**
   * Fiscal memory report for a custom period.
   *
   *   0x7B brief, 0x7A detailed; data is "DDMMYY;DDMMYY" (semicolon separated).
   *
   * Note the separator differs from the ISL family's comma, and the year is two
   * digits unlike ICP's four. The device prints the whole period before
   * answering, so it gets a single attempt with a long deadline.
   */
  async printMonthlyReport(periodReport) {
    const invalid = this.validatePeriodReport(periodReport);
    if (!invalid.Ok) {
      return invalid;
    }
    const status = new DeviceStatusWithReceiptInfo();
    try {
      const start = formatDateDDMMYY(periodReport.StartDate);
      const end = formatDateDDMMYY(periodReport.EndDate);
      const cmd = isDetailedPeriodReport(periodReport)
        ? CMD.FMReportByDateDetailed
        : CMD.FMReportByDateBrief;
      await this._sendCommand(cmd, iconv.encode(`${start};${end}`, 'cp1251'), 1);
    } catch (e) {
      status.addError('E402', e.message);
    }
    return status;
  }

  async printXReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try { await this._sendCommand(CMD.PrintDailyReport, iconv.encode('X', 'cp1251')); }
    catch (e) { status.addError('E401', e.message); }
    return status;
  }

  async printDuplicate(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try { await this._sendCommand(CMD.PrintLastDuplicate, null); }
    catch (e) { status.addError('E500', e.message); }
    return status;
  }

  async reset(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try { await this._sendCommand(CMD.AbortReceipt, null); }
    catch (e) { status.addError('E600', e.message); }
    return status;
  }
}
