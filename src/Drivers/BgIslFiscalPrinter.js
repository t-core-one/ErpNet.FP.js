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
import { withMaxLength, wrapAtLength } from '../Helpers/Helpers.js';
import { InvalidResponseException } from '../Exceptions/InvalidResponseException.js';

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
      [TaxGroup.TaxGroup1]: '\xc0', // А in cp1251
      [TaxGroup.TaxGroup2]: '\xc1', // Б
      [TaxGroup.TaxGroup3]: '\xc2', // В
      [TaxGroup.TaxGroup4]: '\xc3', // Г
      [TaxGroup.TaxGroup5]: '\xc4', // Д
      [TaxGroup.TaxGroup6]: '\xc5', // Е
      [TaxGroup.TaxGroup7]: '\xc6', // Ж
      [TaxGroup.TaxGroup8]: '\xc7', // З
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
      // data starts right after CMD_ECHO (4 header bytes), ends at SEPARATOR
      const dataStart = preIdx + 4;
      const sepIdx = response.indexOf(SEPARATOR, dataStart);
      const dataEnd = (sepIdx >= dataStart && sepIdx < postIdx) ? sepIdx : postIdx;
      const responseData = dataStart < dataEnd ? response.slice(dataStart, dataEnd) : Buffer.alloc(0);
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
    const dtStr = reversalReceipt.ReceiptDateTime
      ? this._formatDateForReversal(reversalReceipt.ReceiptDateTime) : '';
    return `${op},${pass},${usn}\t${reason},${receiptNum},${fmSerial},${dtStr}`;
  }

  _formatDateForReversal(dt) {
    const pad2 = n => String(n).padStart(2, '0');
    return `${pad2(dt.getDate())}-${pad2(dt.getMonth() + 1)}-${dt.getFullYear()} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
  }

  getReversalReasonText(reason) {
    switch (reason) {
      case 1 /* OperatorError */: return '1';
      case 2 /* Refund */: return '0';
      case 3 /* TaxBaseReduction */: return '2';
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
    if (qty !== 0) str += `*${qty}`;
    if (item.PriceModifierType !== PriceModifierType.None) {
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

  async _addComment(text) {
    const lines = wrapAtLength(text, this.info.CommentTextMaxLength || 36);
    for (const line of lines) {
      await this._sendCommand(CMD.FiscalReceiptComment, line);
    }
  }

  async _addPayment(payment) {
    const typeText = this.getPaymentTypeText(payment.PaymentType);
    const amount = (payment.Amount || 0).toFixed(2);
    // Protocol: \t{paymentType}{amount}  — tab comes first, type and amount are concatenated
    await this._sendCommand(CMD.FiscalReceiptTotal, `\t${typeText}${amount}`);
  }

  async _closeReceipt() {
    await this._sendCommand(CMD.CloseFiscalReceipt, null);
  }

  async _getLastReceiptInfo() {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      const resp = await this._sendCommand(CMD.ReadLastQRCode, null);
      const qr = iconv.decode(resp || Buffer.alloc(0), 'cp1251').trim();
      // Parse QR similar to ZFP: FM*Num*Date*Time*Amount
      const parts = qr.split('*');
      if (parts.length >= 4) {
        status.FiscalMemorySerialNumber = parts[0];
        status.ReceiptNumber = parts[1];
        const dateStr = parts[2];
        const timeStr = parts[3];
        if (dateStr.length >= 6) {
          const day = parseInt(dateStr.slice(0, 2), 10);
          const mon = parseInt(dateStr.slice(2, 4), 10) - 1;
          const yr = 2000 + parseInt(dateStr.slice(4, 6), 10);
          let hh = 0, mm = 0, ss = 0;
          if (timeStr.length >= 6) {
            hh = parseInt(timeStr.slice(0, 2), 10);
            mm = parseInt(timeStr.slice(2, 4), 10);
            ss = parseInt(timeStr.slice(4, 6), 10);
          }
          status.ReceiptDateTime = new Date(yr, mon, day, hh, mm, ss);
        }
        if (parts.length >= 5) status.ReceiptAmount = parseFloat(parts[4]) || 0;
      } else {
        // Fallback: get last doc number
        const numResp = await this._sendCommand(CMD.GetLastDocumentNumber, null);
        const numStr = iconv.decode(numResp || Buffer.alloc(0), 'cp1251').trim();
        status.ReceiptNumber = numStr;
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
      await this._openReceipt(receipt);
      for (const item of receipt.Items) {
        if (item.Type === ItemType.Comment || item.Type === ItemType.FooterComment) {
          await this._addComment(item.Text);
        } else {
          await this._addSale(item);
        }
      }
      for (const payment of receipt.Payments) {
        await this._addPayment(payment);
      }
      await this._closeReceipt();
      const info = await this._getLastReceiptInfo();
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
        } else {
          await this._addSale(item);
        }
      }
      for (const payment of (reversalReceipt.Payments || [])) {
        await this._addPayment(payment);
      }
      await this._closeReceipt();
      const info = await this._getLastReceiptInfo();
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

  async printZReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
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
      await this._sendCommand(CMD.PrintDailyReport, '2');
    } catch (e) {
      status.addError('E401', e.message);
    }
    return status;
  }

  async printMonthlyReport(dateRange) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      const pad2 = n => String(n).padStart(2, '0');
      // Protocol date format: DDMMYY (no separators)
      const toDeviceDate = iso => {
        const d = new Date(iso);
        return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${String(d.getFullYear()).slice(-2)}`;
      };
      const start = dateRange && dateRange.StartDate ? toDeviceDate(dateRange.StartDate) : '';
      const end   = dateRange && dateRange.EndDate   ? toDeviceDate(dateRange.EndDate)   : '';
      const data = end ? `${start},${end}` : start;
      // 0x4F = short report, 0x5E = full/detailed report
      const cmd = (dateRange && dateRange.Detailed)
        ? CMD.FiscalMemoryFullReport
        : CMD.FiscalMemoryShortReport;
      await this._sendCommand(cmd, data, 1, 90000);
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
