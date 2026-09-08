import iconv from 'iconv-lite';
import logger from '../logger.js';
import { BgFiscalPrinter } from './BgFiscalPrinter.js';
import {
  DeviceStatusWithDateTime,
  DeviceStatusWithRawResponse,
  DeviceStatusWithCashAmount,
  DeviceStatusWithReceiptInfo,
} from '../Core/DeviceStatus.js';
import { ItemType, PriceModifierType, TaxGroup } from '../Core/Item.js';
import { PaymentType } from '../Core/Payment.js';
import { isDetailedPeriodReport, formatDateDDMMYY } from '../Helpers/periodReport.js';
import { formatQuantity, withMaxLength, wrapAtLength } from '../Helpers/Helpers.js';
import { InvalidResponseException } from '../Exceptions/InvalidResponseException.js';
import { StandardizedStatusMessageException } from '../Exceptions/StandardizedStatusMessageException.js';

/**
 * Hard failures reported in the ISL status bytes, as [byteIndex, bit, message].
 *
 * DELIBERATELY CONSERVATIVE. Every status byte carries 0x80 as a marker plus 7
 * flag bits, and on a perfectly healthy FP-800 the observed status is
 * `88 80 80 ea 86 9a` — i.e. bytes 3-5 have many bits set as normal
 * informational state (fiscal mode, FM formatted, ...) and byte 0 bit 3 ("no
 * external display") is set too. Treating "any bit set" as an error would fail
 * every single operation, so only bits that unambiguously mean "the device did
 * not carry out your command" are listed here. Anything else is left alone.
 */
const STATUS_ERROR_BITS = [
  [0, 0, 'syntax error in the command'],
  [0, 1, 'command rejected as invalid by the device'],
  [2, 0, 'out of paper'],
];

/** Human-readable hard errors present in an ISL status field (empty when fine). */
export function describeStatusErrors(statusBytes) {
  const errors = [];
  for (const [idx, bit, message] of STATUS_ERROR_BITS) {
    if (idx < statusBytes.length && (statusBytes[idx] & 0x7f) & (1 << bit)) {
      errors.push(message);
    }
  }
  return errors;
}

// ─── Protocol constants ────────────────────────────────────────────────────
const PREAMBLE   = 0x01;
const POSTAMBLE  = 0x05;
const SEPARATOR  = 0x04;
const TERMINATOR = 0x03;
const SYN        = 0x16;
const NAK        = 0x15;

// ─── Command codes ─────────────────────────────────────────────────────────
const CMD = {
  GetStatus:                  0x4A,
  GetDeviceInfo:              0x5A,
  MoneyTransfer:              0x46,
  OpenFiscalReceipt:          0x30,
  CloseFiscalReceipt:         0x38,
  AbortFiscalReceipt:         0x3C,
  FiscalReceiptTotal:         0x35,
  FiscalReceiptComment:       0x36,
  FiscalReceiptSale:          0x31,
  PrintDailyReport:           0x45,
  FiscalMemoryShortReport:    0x4F,
  FiscalMemoryFullReport:     0x5E,
  GetDateTime:                0x3E,
  SetDateTime:                0x3D,
  GetReceiptStatus:           0x4C,
  GetLastDocumentNumber:      0x71,
  GetTaxIdentificationNumber: 0x63,
  PrintLastReceiptDuplicate:  0x6D,
  Subtotal:                   0x33,
  ReadLastQRCode:             0x74,
  ToPinpad:                   0x37,
};

export class BgIslFiscalPrinter extends BgFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this._seqNum = 0;

    // Bytes before the response payload: PREAMBLE | LEN | SEQ | CMD_ECHO, one
    // each in this dialect. BgDatecsXIslFiscalPrinter raises it to 10, matching
    // the wider LEN and CMD fields its frame builder writes.
    this.responseHeaderLength = 4;

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

  /**
   * Which status bits mean "this command failed".
   *
   * Overridable per device family: Datecs C, P and X each publish a different
   * table, so a shared one is either too narrow (a real rejection passes as
   * success) or too wide (a healthy device fails every command). The base is
   * the conservative subset common to all ISL devices; BgDatecsPIslFiscalPrinter
   * supplies the full FP-700/FP-800 table.
   */
  describeStatusErrors(statusBytes) {
    return describeStatusErrors(statusBytes);
  }

  getTaxGroupText(taxGroup) {
    const map = {
      [TaxGroup.TaxGroup1]: 'А', // U+0410 → cp1251 0xC0
      [TaxGroup.TaxGroup2]: 'Б', // U+0411 → cp1251 0xC1
      [TaxGroup.TaxGroup3]: 'В', // U+0412 → cp1251 0xC2
      [TaxGroup.TaxGroup4]: 'Г', // U+0413 → cp1251 0xC3
      [TaxGroup.TaxGroup5]: 'Д', // U+0414 → cp1251 0xC4
      [TaxGroup.TaxGroup6]: 'Е', // U+0415 → cp1251 0xC5
      [TaxGroup.TaxGroup7]: 'Ж', // U+0416 → cp1251 0xC6
      [TaxGroup.TaxGroup8]: 'З', // U+0417 → cp1251 0xC7
    };
    return map[taxGroup] || map[TaxGroup.TaxGroup1];
  }

  // ─── Frame building ──────────────────────────────────────────────────────

  _nextSeq() {
    // FrameSequenceNumber cycles 0..0x5F; SEQ byte = 0x20 + counter (kept in printable ASCII)
    this._seqNum = (this._seqNum + 1) % 0x60;
    return 0x20 + this._seqNum;
  }

  _buildHostFrame(seq, cmd, data) {
    // Request frame: PREAMBLE | LEN | SEQ | CMD | data | POSTAMBLE | BCC[4] | TERMINATOR
    // LEN = 0x20 + 4 + len(data)  — MarkerSpace offset keeps it out of control-char range
    // There is NO separator byte in the request (separator only appears in the response).
    // BCC = sum of [LEN, SEQ, CMD, data..., POSTAMBLE]
    const dataLen = data ? data.length : 0;
    const lenByte = 0x20 + 4 + dataLen;

    let bcc = lenByte + seq + cmd + POSTAMBLE;
    if (data) for (const b of data) bcc += b;

    const bccBytes = Buffer.from([
      ((bcc >> 12) & 0x0F) + 0x30,
      ((bcc >> 8) & 0x0F) + 0x30,
      ((bcc >> 4) & 0x0F) + 0x30,
      (bcc & 0x0F) + 0x30,
    ]);

    return Buffer.concat([
      Buffer.from([PREAMBLE, lenByte, seq, cmd]),
      data || Buffer.alloc(0),
      Buffer.from([POSTAMBLE]),
      bccBytes,
      Buffer.from([TERMINATOR]),
    ]);
  }

  async _sendCommand(cmd, data, retries = 3, timeoutMs = 5000) {
    const seq = this._nextSeq();
    const frameData = data instanceof Buffer ? data :
                      (data ? iconv.encode(data, 'cp1251') : null);
    const frame = this._buildHostFrame(seq, cmd, frameData || null);

    for (let attempt = 0; attempt < retries; attempt++) {
      await this._channel.write(frame);

      const deadline = Date.now() + timeoutMs;
      let response = Buffer.alloc(0);

      while (Date.now() < deadline) {
        const chunk = await this._channel.read();
        if (chunk && chunk.length > 0) {
          response = Buffer.concat([response, chunk]);
          if (response.includes(TERMINATOR)) break;
        }
        await new Promise(r => setTimeout(r, 30));
      }

      if (!response || response.length === 0) continue;

      const preIdx = response.indexOf(PREAMBLE);
      const termIdx = response.lastIndexOf(TERMINATOR);
      if (preIdx < 0 || termIdx <= preIdx) continue;

      const postIdx = response.lastIndexOf(POSTAMBLE, termIdx);
      if (postIdx < 0) continue;

      // Response: PREAMBLE | LEN | SEQ | CMD_ECHO | data | SEPARATOR | status | POSTAMBLE
      // data starts right after CMD_ECHO, ends at SEPARATOR. The header is four
      // bytes in this dialect, but the Datecs X series widens LEN and CMD to
      // four bytes each, so the offset is a property rather than a constant.
      const dataStart = preIdx + this.responseHeaderLength;
      const sepIdx = response.indexOf(SEPARATOR, dataStart);
      const dataEnd = (sepIdx >= dataStart && sepIdx < postIdx) ? sepIdx : postIdx;
      const responseData = dataStart < dataEnd ? response.slice(dataStart, dataEnd) : Buffer.alloc(0);

      // The status field sits between SEPARATOR and POSTAMBLE. It used to be
      // discarded entirely, so a device that REJECTED the command still looked
      // like a success to the caller — e.g. the POS reported "Fiscal report
      // printed" when the printer had done nothing at all.
      if (sepIdx >= dataStart && sepIdx < postIdx) {
        const statusBytes = response.slice(sepIdx + 1, postIdx);
        // The payload matters as much as the status: on the Datecs X family the
        // COMMAND's result is field 0 of the data (0 = ok, negative = an error
        // code) while the status bytes only describe the PRINTER's condition.
        // Logging only the status hid a failing close behind a healthy printer.
        logger.debug(`cmd 0x${cmd.toString(16)} status=${statusBytes.toString('hex')} `
          + `dataLen=${responseData.length} data=${JSON.stringify(iconv.decode(responseData, 'cp1251').slice(0, 120))}`);
        const errors = this.describeStatusErrors(statusBytes);
        if (errors.length) {
          // Do not retry: a rejection is deterministic, and re-sending a fiscal
          // command that the device already parsed is never the right recovery.
          const rejection = new StandardizedStatusMessageException(
            `Device rejected command 0x${cmd.toString(16)}: ${errors.join('; ')}`
          );
          // Carry the payload on the exception. The status bytes describe the
          // condition of the PRINTER, not the outcome of the command, and both
          // arrive in the same answer — so for some commands the data proves the
          // operation succeeded even though the status looks bad. Discarding it
          // here would make that indistinguishable from a real failure (see
          // BgDatecsXIslFiscalPrinter._closeReceipt).
          rejection.responseData = responseData;
          rejection.command = cmd;
          throw rejection;
        }
      }
      return responseData;
    }
    throw new InvalidResponseException('No valid ISL response received after retries');
  }

  async getRawDeviceInfo() {
    const resp = await this._sendCommand(CMD.GetDeviceInfo, '1');
    return iconv.decode(resp || Buffer.alloc(0), 'cp1251');
  }

  async rawRequest(requestFrame) {
    const status = new DeviceStatusWithRawResponse();
    try {
      const raw = requestFrame.RawRequest || '';
      const sepIdx = raw.indexOf(';');
      const cmdCode = parseInt(sepIdx >= 0 ? raw.slice(0, sepIdx) : raw, 16);
      const argStr = sepIdx >= 0 ? raw.slice(sepIdx + 1) : '';
      const resp = await this._sendCommand(cmdCode, argStr || null);
      status.RawResponse = iconv.decode(resp || Buffer.alloc(0), 'cp1251');
    } catch (e) {
      status.addError('E999', e.message);
    }
    return status;
  }

  // ─── Printer operations ──────────────────────────────────────────────────

  async checkStatus() {
    const status = new DeviceStatusWithDateTime();
    try {
      const resp = await this._sendCommand(CMD.GetDateTime, null);
      const str = iconv.decode(resp, 'cp1251').trim();
      // "DD-MM-YY HH:MM:SS" or "DD.MM.YY HH:MM:SS"
      const m = str.match(/(\d{2})[-./](\d{2})[-./](\d{2,4})\s+(\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
        status.DeviceDateTime = new Date(yr, parseInt(m[2], 10) - 1, parseInt(m[1], 10),
          parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10));
      }
    } catch (e) {
      status.addError('E001', e.message);
    }
    return status;
  }

  async setDateTime(datetime) {
    const raw = datetime && datetime.DeviceDateTime;
    const dt = raw ? new Date(raw) : new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const str = `${pad2(dt.getDate())}-${pad2(dt.getMonth() + 1)}-${String(dt.getFullYear()).slice(-2)} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
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
      // Send MoneyTransfer with amount "0" — the printer responds with current cash totals.
      const resp = await this._sendCommand(CMD.MoneyTransfer, '0');
      const str = iconv.decode(resp, 'cp1251');
      logger.debug(`cash() raw response: "${str}"`);
      const parts = str.split(',');
      if (parts.length < 4) {
        status.addError('E409', `Invalid cash response format: "${str}"`);
      } else if (parts[0] === 'F') {
        status.addError('E409', 'Cash query denied by printer (F). Receipt may be open.');
      } else {
        const amountStr = parts[1];
        // Amount may be in cents (no decimal point) or already decimal
        status.Amount = amountStr.includes('.')
          ? parseFloat(amountStr)
          : parseInt(amountStr, 10) / 100;
        logger.debug(`cash() parsed: raw="${amountStr}" amount=${status.Amount}`);
      }
    } catch (e) {
      status.addError('E003', e.message);
    }
    return status;
  }

  _formatOpenReceipt(receipt) {
    const op = receipt.Operator || '1';
    const pass = receipt.OperatorPassword || '';
    const usn = receipt.UniqueSaleNumber || '';
    return `${op},${pass},${usn}`;
  }

  _formatOpenReversalReceipt(reversalReceipt) {
    const op = reversalReceipt.Operator || '1';
    const pass = reversalReceipt.OperatorPassword || '';
    const usn = reversalReceipt.UniqueSaleNumber || '';
    const receiptNum = reversalReceipt.ReceiptNumber || '';
    const fmSerial = reversalReceipt.FiscalMemorySerialNumber || '';
    const reason = this.getReversalReasonText(reversalReceipt.Reason);
    const rawDt = reversalReceipt.ReceiptDateTime;
    const dtObj = rawDt ? (rawDt instanceof Date ? rawDt : new Date(rawDt)) : null;
    const dtStr = dtObj ? this._formatDateForReversal(dtObj) : '';
    return `${op},${pass},${usn}\t${reason},${receiptNum},${fmSerial},${dtStr}`;
  }

  _formatDateForReversal(dt) {
    const d = (dt instanceof Date) ? dt : new Date(dt);
    const pad2 = n => String(n).padStart(2, '0');
    return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  getReversalReasonText(reason) {
    switch (reason) {
      case ReversalReason.OperatorError: return '1';
      case ReversalReason.Refund: return '0';
      case ReversalReason.TaxBaseReduction: return '2';
      case 'taxbase-reduction': return '2'; // backward compat
      default: return '1';
    }
  }

  async _openReceipt(receipt) {
    await this._sendCommand(CMD.OpenFiscalReceipt, this._formatOpenReceipt(receipt));
  }

  async _openReversalReceipt(reversalReceipt) {
    await this._sendCommand(CMD.OpenFiscalReceipt, this._formatOpenReversalReceipt(reversalReceipt));
  }

  async _addSale(item) {
    const taxText = this.getTaxGroupText(item.TaxGroup || TaxGroup.TaxGroup1);
    const text = withMaxLength(item.Text || '', this.info.ItemTextMaxLength || 36);
    const price = (item.UnitPrice || 0).toFixed(2);
    const dept = item.Department || 0;
    const qty = item.Quantity || 0;

    // Protocol: [text]\t[taxCd][price][*qty][,pct|$abs]
    let str = dept <= 0
      ? `${text}\t${taxText}${price}`
      : `${text}\t${dept}\t${price}`;
    if (qty !== 0) str += `*${formatQuantity(qty)}`;
    if (item.PriceModifierType) {
      const val = item.PriceModifierValue || 0;
      switch (item.PriceModifierType) {
        case PriceModifierType.DiscountPercent:  str += `,${(-val).toFixed(2)}`; break;
        case PriceModifierType.DiscountAmount:   str += `$${(-val).toFixed(2)}`; break;
        case PriceModifierType.SurchargePercent: str += `,${val.toFixed(2)}`; break;
        case PriceModifierType.SurchargeAmount:  str += `$${val.toFixed(2)}`; break;
      }
    }
    logger.debug(`_addSale: cmd="${str}" (UnitPrice=${item.UnitPrice}, TaxGroup=${item.TaxGroup}, Qty=${item.Quantity})`);
    await this._sendCommand(CMD.FiscalReceiptSale, str);
  }

  /**
   * Refuse to close a receipt whose total the device and the caller disagree on.
   *
   * The caller computes the money (Odoo does, here) and the DEVICE computes it
   * again from unit prices, quantities and discounts. When a discount makes the
   * two diverge — even by one stotinka — the receipt cannot be paid off, the
   * device refuses to close it, and it is left OPEN. That corrupts the next
   * receipt as well, which is how this surfaced in production.
   *
   * Catching it here makes the failure independent of every arithmetic subtlety
   * in how discounts are expressed: whatever the cause, the receipt is aborted
   * with a clear message instead of being abandoned half-printed. Tolerance is
   * one stotinka, since a residual that small is exactly the rounding case and
   * still leaves the receipt unclosable.
   */
  async _assertReceiptSettled(payments) {
    if (!payments || this._payableOnly(payments).length === 0) {
      return; // _fullPayment() pays whatever the device computed, by definition
    }
    const tendered = this._payableOnly(payments).reduce((sum, p) => sum + (p.Amount || 0), 0);
    let deviceAmount;
    try {
      deviceAmount = await this._getReceiptAmount();
    } catch (e) {
      return; // never fail a good receipt because the probe itself failed
    }
    if (deviceAmount == null || !Number.isFinite(deviceAmount) || deviceAmount === 0) {
      return; // nothing trustworthy to compare against
    }
    // Only a SHORTFALL is fatal. Tendering more than the total is normal — the
    // device keeps the difference as change — so an excess must not be blocked.
    const shortfall = Math.round((deviceAmount - tendered) * 100) / 100;
    if (shortfall >= 0.01) {
      throw new StandardizedStatusMessageException(
        `Receipt underpaid: the device computed ${deviceAmount.toFixed(2)} but only `
        + `${tendered.toFixed(2)} was tendered (short by ${shortfall.toFixed(2)}). `
        + `Refusing to close — the device would leave the receipt open. `
        + `This usually means a discount was expressed so that the device's arithmetic `
        + `differs from the caller's.`
      );
    }
  }

  async _addSubtotalChangeAmount(amount) {
    // ISL format: "10;{amount:F2}" — negative = discount, positive = surcharge
    await this._sendCommand(CMD.Subtotal, `10;${amount.toFixed(2)}`);
  }

  async _fullPayment() {
    // Tab-only = full amount as cash, no change
    await this._sendCommand(CMD.FiscalReceiptTotal, '\t');
  }

  async _addComment(text) {
    const lines = wrapAtLength(text, this.info.CommentTextMaxLength || 36);
    for (const line of lines) {
      await this._sendCommand(CMD.FiscalReceiptComment, line);
    }
  }

  /**
   * Payments the device will actually accept.
   *
   * A "change" line is not a payment on this protocol. The POS reports change as
   * a negative amount, PaymentType.Change has no entry in paymentTypeMappings,
   * and getPaymentTypeText falls back to '0' — so it went on the wire as
   * "\t0-4.12", a negative CASH payment. Observed on the Mechka FP-800:
   *
   *   0x35 status=888088ea869a dataLen=11   <- 10.30 cash, accepted
   *   0x35 status=a98088ea869a dataLen=1    <- -4.12 change, E401 syntax error
   *   0x3c                                  <- receipt aborted, half printed
   *
   * The device derives change from the tendered amount, so the line is dropped.
   */
  _payableOnly(payments) {
    if (!payments) return [];
    return payments.filter(
      (p) => p && p.PaymentType !== PaymentType.Change && (p.Amount || 0) >= 0
    );
  }

  async _addPayment(payment) {
    const typeText = this.getPaymentTypeText(payment.PaymentType);
    const amount = (payment.Amount || 0).toFixed(2);
    // Protocol: \t{paymentType}{amount}  — tab comes first, type and amount are concatenated
    await this._sendCommand(CMD.FiscalReceiptTotal, `\t${typeText}${amount}`);
  }

  async _closeReceipt() {
    // The response matters: on the Datecs X series it carries the document
    // number, which is the only place that number can be read from — that
    // family rejects the separate GetLastDocumentNumber command outright.
    const resp = await this._sendCommand(CMD.CloseFiscalReceipt, null);
    return iconv.decode(resp || Buffer.alloc(0), 'cp1251');
  }

  async _getReceiptAmount() {
    // Command 0x4C "T" → "sign+amount_in_stotinki" or "amount.decimal" in field[2]
    // Must be called BEFORE closing the receipt.
    try {
      const resp = await this._sendCommand(CMD.GetReceiptStatus, 'T');
      const str = iconv.decode(resp || Buffer.alloc(0), 'cp1251').trim();
      const fields = str.split(',');
      if (fields.length >= 3) {
        const raw = fields[2].trim();
        if (raw.startsWith('+')) return parseFloat(raw.slice(1)) / 100;
        if (raw.startsWith('-')) return -parseFloat(raw.slice(1)) / 100;
        if (raw.includes('.')) return parseFloat(raw);
        return parseFloat(raw) / 100;
      }
    } catch (_) {}
    return 0;
  }

  async _getLastReceiptInfo(closeResponse) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      // FM serial is already known from device detection
      status.FiscalMemorySerialNumber = this.info.FiscalMemorySerialNumber || '';

      // Get current printer date/time (format: "dd-MM-yy HH:mm:ss" or "dd.MM.yy HH:mm:ss")
      const dtResp = await this._sendCommand(CMD.GetDateTime, null);
      const dtStr = iconv.decode(dtResp || Buffer.alloc(0), 'cp1251').trim();
      const m = dtStr.match(/(\d{2})[-.](\d{2})[-.](\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        status.ReceiptDateTime = new Date(2000 + parseInt(m[3], 10), parseInt(m[2], 10) - 1,
          parseInt(m[1], 10), parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10));
      }

      // Get receipt number. How that is obtained is family-specific, so it
      // goes through a method the drivers can override.
      status.ReceiptNumber = await this._getLastDocumentNumber(closeResponse);
    } catch (e) {
      status.addError('E010', e.message);
    }
    return status;
  }

  /**
   * The number the device assigned to the document just closed.
   *
   * Most of the ISL family answers a dedicated command for this. The Datecs X
   * series does not — it rejects 0x71 with "command code is invalid" and returns
   * the number in the close-receipt response instead, so that driver overrides
   * this and the close response is threaded through for it.
   */
  async _getLastDocumentNumber(_closeResponse) {
    const numResp = await this._sendCommand(CMD.GetLastDocumentNumber, null);
    return iconv.decode(numResp || Buffer.alloc(0), 'cp1251').trim();
  }

  async printReceipt(receipt) {
    logger.debug(`printReceipt: Items=${JSON.stringify(receipt.Items)?.slice(0,200)}, Payments=${JSON.stringify(receipt.Payments)?.slice(0,100)}`);
    const validation = this.validateReceipt(receipt);
    if (!validation.Ok) return validation;

    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._openReceipt(receipt);
      for (const item of receipt.Items) {
        if (item.Type === ItemType.Comment || item.Type === ItemType.FooterComment) {
          await this._addComment(item.Text);
        } else if (item.Type === ItemType.DiscountAmount) {
          await this._addSubtotalChangeAmount(-(item.Amount || 0));
        } else if (item.Type === ItemType.SurchargeAmount) {
          await this._addSubtotalChangeAmount(item.Amount || 0);
        } else {
          await this._addSale(item);
        }
      }
      if (!receipt.Payments || receipt.Payments.length === 0) {
        await this._fullPayment();
      } else {
        for (const payment of this._payableOnly(receipt.Payments)) {
          await this._addPayment(payment);
        }
      }
      await this._assertReceiptSettled(receipt.Payments);
      const receiptAmount = await this._getReceiptAmount();
      const closeResponse = await this._closeReceipt();
      const info = await this._getLastReceiptInfo(closeResponse);
      info.ReceiptAmount = receiptAmount;
      Object.assign(status, info);
    } catch (e) {
      status.addError('E100', e.message);
      try { await this._sendCommand(CMD.AbortFiscalReceipt, null); } catch (_) {}
    }
    return status;
  }

  async printReversalReceipt(reversalReceipt) {
    const validation = this.validateReversalReceipt(reversalReceipt);
    if (!validation.Ok) return validation;

    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._openReversalReceipt(reversalReceipt);
      for (const item of (reversalReceipt.Items || [])) {
        if (item.Type === ItemType.Comment || item.Type === ItemType.FooterComment) {
          await this._addComment(item.Text);
        } else if (item.Type === ItemType.DiscountAmount) {
          await this._addSubtotalChangeAmount(-(item.Amount || 0));
        } else if (item.Type === ItemType.SurchargeAmount) {
          await this._addSubtotalChangeAmount(item.Amount || 0);
        } else {
          await this._addSale(item);
        }
      }
      if (!reversalReceipt.Payments || reversalReceipt.Payments.length === 0) {
        await this._fullPayment();
      } else {
        for (const payment of this._payableOnly(reversalReceipt.Payments)) {
          await this._addPayment(payment);
        }
      }
      await this._assertReceiptSettled(reversalReceipt.Payments);
      const receiptAmount = await this._getReceiptAmount();
      const closeResponse = await this._closeReceipt();
      const info = await this._getLastReceiptInfo(closeResponse);
      info.ReceiptAmount = receiptAmount;
      Object.assign(status, info);
    } catch (e) {
      status.addError('E200', e.message);
      try { await this._sendCommand(CMD.AbortFiscalReceipt, null); } catch (_) {}
    }
    return status;
  }


  async printMoneyDeposit(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithCashAmount();
    try {
      const amount = transferAmount.Amount.toFixed(2);
      logger.debug(`printMoneyDeposit: sending amount="${amount}"`);
      const resp = await this._sendCommand(CMD.MoneyTransfer, amount);
      const str = iconv.decode(resp, 'cp1251');
      logger.debug(`printMoneyDeposit: raw response="${str}"`);
      const parts = str.split(',');
      if (parts[0] === 'F') {
        status.addError('E300', `Deposit denied by printer (F): ${str}`);
      } else {
        status.Amount = transferAmount.Amount;
      }
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
      const amount = (-transferAmount.Amount).toFixed(2);
      logger.debug(`printMoneyWithdraw: sending amount="${amount}"`);
      const resp = await this._sendCommand(CMD.MoneyTransfer, amount);
      const str = iconv.decode(resp, 'cp1251');
      logger.debug(`printMoneyWithdraw: raw response="${str}"`);
      const parts = str.split(',');
      if (parts[0] === 'F') {
        status.addError('E301', `Withdrawal denied by printer (F) — insufficient cash: ${str}`);
      } else {
        status.Amount = transferAmount.Amount;
      }
    } catch (e) {
      status.addError('E300', e.message);
    }
    return status;
  }

  async _abortIfReceiptOpen() {
    try {
      const resp = await this._sendCommand(CMD.GetReceiptStatus, 'T');
      const str = iconv.decode(resp || Buffer.alloc(0), 'cp1251').trim();
      if (str.startsWith('1,')) {
        await this._sendCommand(CMD.AbortFiscalReceipt, null);
      }
    } catch (_) {}
  }

  async printZReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._abortIfReceiptOpen();
      // No retries — re-sending a Z report closes the fiscal day twice.
      // 90s timeout — the printer writes to fiscal memory which takes 20-40s.
      await this._sendCommand(CMD.PrintDailyReport, null, 1, 90000);
    } catch (e) {
      status.addError('E400', e.message);
    }
    return status;
  }

  async printXReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._abortIfReceiptOpen();
      await this._sendCommand(CMD.PrintDailyReport, '2');
    } catch (e) {
      status.addError('E401', e.message);
    }
    return status;
  }

  /**
   * Fiscal memory report for a custom period.
   *
   *   0x4F short, 0x5E detailed; data is "{StartDate},{EndDate}", both DDMMYY.
   *
   * Both dates are always sent: omitting the end date makes the device print a
   * monthly (MMYY) or annual (YY) report instead of the requested range.
   *
   * The device prints the whole period before answering, hence the single
   * attempt and the long deadline rather than the usual retry budget.
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
        ? CMD.FiscalMemoryFullReport
        : CMD.FiscalMemoryShortReport;
      await this._sendCommand(cmd, `${start},${end}`, 1, 90000);
    } catch (e) {
      status.addError('E402', e.message);
    }
    return status;
  }

  async printDuplicate(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.PrintLastReceiptDuplicate, null);
    } catch (e) {
      status.addError('E500', e.message);
    }
    return status;
  }

  async reset(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.AbortFiscalReceipt, null);
    } catch (e) {
      status.addError('E600', e.message);
    }
    return status;
  }
}

export { CMD };
