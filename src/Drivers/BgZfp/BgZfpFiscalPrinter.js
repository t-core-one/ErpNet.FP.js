'use strict';

const iconv = require('iconv-lite');
const { BgFiscalPrinter } = require('../BgFiscalPrinter');
const { DeviceInfo } = require('../../Core/DeviceInfo');
const {
  DeviceStatusWithDateTime,
  DeviceStatusWithRawResponse,
  DeviceStatusWithCashAmount,
  DeviceStatusWithReceiptInfo,
} = require('../../Core/DeviceStatus');
const { ItemType, PriceModifierType, TaxGroup } = require('../../Core/Item');
const { PaymentType } = require('../../Core/Payment');
const { ReversalReason } = require('../../Core/ReversalReceipt');
const { withMaxLength, wrapAtLength } = require('../../Helpers/Helpers');
const { InvalidResponseException } = require('../../Exceptions/InvalidResponseException');

// ─── Protocol constants ────────────────────────────────────────────────────
const STX = 0x02;
const ACK = 0x06;
const ETX = 0x0A;
const NACK = 0x15;
const RETRY = 0x0E;
const PING = 0x09;
const MAX_SEQ = 0x7F;

// ─── Command codes ─────────────────────────────────────────────────────────
const CMD = {
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
  Subtotal:                   0x33,
  NoFiscalRA:                 0x3B,
  PrintDailyReport:           0x7C,
  GetDateTime:                0x68,
  SetDateTime:                0x48,
  ReadLastQR:                 0x72,
  ReadDailyAmounts:           0x6E,
  GetTaxId:                   0x61,
  ReadFDNumbers:              0x60,
};

const ITEM_TEXT_MANDATORY_LENGTH = 36;

// ─── Status bits ──────────────────────────────────────────────────────────
const FISCAL_DEVICE_ERRORS = [
  'Fiscal memory is full',
  'Fiscal memory problem',
  'Clock problem',
  'Fiscal memory data problem',
  'Overheat',
  'Tax table problem',
  'Busy',
  'undefined',
];

const COMMAND_ERRORS = [
  'Command not recognized',
  'Invalid argument count',
  'Invalid argument range',
  'Command not permitted at this time',
  'Overflow',
  'Forbidden command (no fiscal close)',
  'Forbidden command in open fiscal receipt',
  'undefined',
];

const STATUS_BITS = [
  // Byte 0
  ['Fiscal memory almost full',    null,                         null,                         null,                 null,                   'undefined',      'undefined',  'undefined'],
  // Byte 1
  ['DateTime not set',             'Fiscal memory full',        'RAM reset',                  null,                 null,                   'undefined',      'undefined',  'undefined'],
  // Byte 2
  ['Receipt opened',               'Fiscal receipt opened',     null,                         null,                 null,                   'undefined',      'undefined',  'undefined'],
  // Byte 3
  FISCAL_DEVICE_ERRORS,
  // Byte 4
  COMMAND_ERRORS,
  // Byte 5
  ['Non fiscal receipt open',      null,                        null,                         null,                 null,                   'undefined',      'undefined',  'undefined'],
  // Byte 6
  [null,                           null,                        null,                         null,                 null,                   'undefined',      'undefined',  'undefined'],
];

// ─── FrameBuilder helper ───────────────────────────────────────────────────
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

// ─── Main class ────────────────────────────────────────────────────────────
class BgZfpFiscalPrinter extends BgFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this._sequenceNumber = 0x20;

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
      [TaxGroup.TaxGroup1]: 'А', // А
      [TaxGroup.TaxGroup2]: 'Б', // Б
      [TaxGroup.TaxGroup3]: 'В', // В
      [TaxGroup.TaxGroup4]: 'Г', // Г
      [TaxGroup.TaxGroup5]: 'Д', // Д
      [TaxGroup.TaxGroup6]: 'Е', // Е
      [TaxGroup.TaxGroup7]: 'Ж', // Ж
      [TaxGroup.TaxGroup8]: 'З', // З
    };
    return map[taxGroup] || map[TaxGroup.TaxGroup1];
  }

  // ─── Frame I/O ──────────────────────────────────────────────────────────

  _nextSeq() {
    this._sequenceNumber = (this._sequenceNumber % MAX_SEQ) + 0x20;
    return this._sequenceNumber;
  }

  _buildHostFrame(seq, cmd, data) {
    // STX LEN SEQ CMD DATA CS ETX
    const cmdByte = Buffer.from([cmd]);
    const payload = data ? Buffer.concat([cmdByte, data]) : cmdByte;
    const len = payload.length + 4; // LEN(1) SEQ(1) payload CS(2)
    const lenByte = Buffer.from([len + 0x20]);
    const seqByte = Buffer.from([seq]);
    const prefix = Buffer.concat([lenByte, seqByte, payload]);

    let cs = 0;
    for (const b of prefix) cs ^= b;

    const csHigh = Buffer.from([(cs >> 4) + 0x30]);
    const csLow = Buffer.from([(cs & 0x0F) + 0x30]);

    return Buffer.concat([Buffer.from([STX]), prefix, csHigh, csLow, Buffer.from([ETX])]);
  }

  async _waitForAck(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const data = await this._channel.read();
      if (data && data.length > 0) {
        if (data[0] === ACK) return true;
        if (data[0] === NACK) return false;
        if (data[0] === RETRY) return false;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('Timeout waiting for ACK');
  }

  _parseResponseStatus(response) {
    if (!response || response.length < 5) return null;
    const stxIdx = response.indexOf(STX);
    if (stxIdx < 0) return null;
    const etxIdx = response.indexOf(ETX, stxIdx);
    if (etxIdx < 0) return null;

    // Frame: STX LEN SEQ CMD status... CS ETX
    // status bytes are at offset 4 (0-based after STX)
    const statusBytes = response.slice(stxIdx + 4, etxIdx - 2);
    return statusBytes;
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

      const stxIdx = response.indexOf(STX);
      const etxIdx = response.lastIndexOf(ETX);
      if (stxIdx < 0 || etxIdx <= stxIdx) continue;

      const frame2 = response.slice(stxIdx, etxIdx + 1);
      const status = this._parseStatus(frame2);
      if (status) {
        this._applyStatus(status);
      }

      // Extract data payload (between CMD byte and CS)
      // Frame: STX LEN SEQ CMD [status 4 bytes] DATA CS CS ETX
      // status=4 bytes at positions 4-7, then data
      const dataStart = stxIdx + 4 + 4; // after STX,LEN,SEQ,CMD + 4 status bytes
      const dataEnd = etxIdx - 2;       // before 2 CS bytes
      if (dataEnd > dataStart) {
        return response.slice(dataStart, dataEnd);
      }
      return Buffer.alloc(0);
    }
    throw new InvalidResponseException('No valid response received after retries');
  }

  _parseStatus(frame) {
    if (!frame || frame.length < 9) return null;
    // Frame: STX(1) LEN(1) SEQ(1) CMD(1) STATUS(4) ... CS(2) ETX(1)
    // status = bytes 4..7
    const statusBytes = Array.from(frame.slice(4, 8));
    return statusBytes;
  }

  _applyStatus(statusBytes) {
    // Just log errors — callers handle via DeviceStatus returns
  }

  _parseCommandStatus(statusWord) {
    const b0 = statusWord[0] || 0;
    const b1 = statusWord[1] || 0;
    const errors = [];
    for (let bit = 0; bit < 8; bit++) {
      if (b0 & (1 << bit)) {
        const msg = COMMAND_ERRORS[bit];
        if (msg && msg !== 'undefined') errors.push(msg);
      }
    }
    return errors;
  }

  _parseDeviceStatus(statusBytes) {
    const status = new DeviceStatusWithDateTime();
    for (let byteIdx = 0; byteIdx < Math.min(statusBytes.length, STATUS_BITS.length); byteIdx++) {
      const byteBits = STATUS_BITS[byteIdx];
      const byteVal = statusBytes[byteIdx] || 0;
      for (let bit = 0; bit < 8; bit++) {
        if (byteVal & (1 << bit)) {
          const msg = byteBits[bit];
          if (msg && msg !== 'undefined' && msg !== null) {
            if (byteIdx === 3 || byteIdx === 4) {
              status.addError(`E${byteIdx}${bit}`, msg);
            } else {
              status.addWarning(`W${byteIdx}${bit}`, msg);
            }
          }
        }
      }
    }
    return status;
  }

  async _getStatus() {
    const response = await this._sendCommand(CMD.GetStatus, null);
    if (!response || response.length < 7) {
      const s = new DeviceStatusWithDateTime();
      s.addError('E000', 'No status response');
      return s;
    }
    return this._parseDeviceStatus(Array.from(response.slice(0, 7)));
  }

  // ─── Printer operations ──────────────────────────────────────────────────

  async checkStatus() {
    const status = new DeviceStatusWithDateTime();
    try {
      const resp = await this._sendCommand(CMD.GetDateTime, null);
      const dtStr = iconv.decode(resp, 'cp1251');
      if (dtStr) {
        // Format: "DD-MM-YY HH:MM:SS" or "DD-MM-YYYY HH:MM:SS"
        const m = dtStr.trim().match(/(\d{2})-(\d{2})-(\d{2,4})\s+(\d{2}):(\d{2}):(\d{2})/);
        if (m) {
          const year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
          status.DeviceDateTime = new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10),
            parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10));
        }
      }
    } catch (e) {
      status.addError('E001', e.message);
    }
    return status;
  }

  async setDateTime(datetime) {
    const dt = datetime.DeviceDateTime || new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const str = `${pad2(dt.getDate())}-${pad2(dt.getMonth() + 1)}-${dt.getFullYear()} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
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
      // Response has multiple comma-separated fields; first is cash total
      const parts = str.split(',');
      if (parts.length > 0) {
        status.Amount = parseFloat(parts[0]) || 0;
      }
    } catch (e) {
      status.addError('E003', e.message);
    }
    return status;
  }

  async _openReceipt(receipt, isReversal = false, reversalReceipt = null) {
    const op = receipt.Operator || '1';
    const pass = receipt.OperatorPassword || '';
    const usn = receipt.UniqueSaleNumber || '';

    let str;
    if (isReversal && reversalReceipt) {
      const reason = this.getReversalReasonText(reversalReceipt.Reason);
      const receiptNum = reversalReceipt.ReceiptNumber || '';
      const fmSerial = reversalReceipt.FiscalMemorySerialNumber || '';
      const dtStr = reversalReceipt.ReceiptDateTime
        ? this._formatDateTimeForReceipt(reversalReceipt.ReceiptDateTime)
        : '';
      str = `${op},${pass},${usn},S,${fmSerial},${reason},${receiptNum},${dtStr}`;
    } else {
      str = `${op},${pass},${usn}`;
    }

    await this._sendCommand(CMD.OpenReceipt, iconv.encode(str, 'cp1251'));
  }

  _formatDateTimeForReceipt(dt) {
    if (!dt) return '';
    const pad2 = n => String(n).padStart(2, '0');
    return `${pad2(dt.getDate())}${pad2(dt.getMonth() + 1)}${String(dt.getFullYear()).slice(-2)}${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
  }

  async _addItem(item) {
    const taxText = this.getTaxGroupText(item.TaxGroup || TaxGroup.TaxGroup1);
    const text = withMaxLength(item.Text || '', ITEM_TEXT_MANDATORY_LENGTH);
    const paddedText = text.padEnd(ITEM_TEXT_MANDATORY_LENGTH, ' ');

    const qty = (item.Quantity || 1).toFixed(3);
    const price = (item.UnitPrice || 0).toFixed(2);
    const amount = (item.Amount || 0).toFixed(2);

    const dept = item.Department || 0;

    let frame;
    if (dept > 0) {
      // Department sell: SellCorrectionDepartment
      // Format: text\tprice\tqty\tdept
      const fb = new FrameBuilder();
      fb.addString(paddedText);
      fb.addString(`\t${price}\t${qty}\t`);
      // Department byte: 0x80 + dept number
      fb.addByte(0x80 + dept);
      frame = fb.build();
      await this._sendCommand(CMD.SellCorrectionDepartment, frame);
    } else {
      // Regular sell with tax group
      const fb = new FrameBuilder();
      fb.addString(paddedText);
      // Tax group character (Cyrillic, cp1251)
      const taxBuf = iconv.encode(taxText, 'cp1251');
      fb.addByte(taxBuf[0]);
      fb.addString(`\t${price}\t${qty}`);
      frame = fb.build();
      await this._sendCommand(CMD.SellCorrection, frame);
    }

    // Apply price modifier if any
    if (item.PriceModifierType !== PriceModifierType.None) {
      await this._applyPriceModifier(item);
    }
  }

  async _applyPriceModifier(item) {
    let str;
    const val = (item.PriceModifierValue || 0).toFixed(2);
    switch (item.PriceModifierType) {
      case PriceModifierType.DiscountPercent:   str = `-${val}%`; break;
      case PriceModifierType.DiscountAmount:    str = `-${val}`; break;
      case PriceModifierType.SurchargePercent:  str = `+${val}%`; break;
      case PriceModifierType.SurchargeAmount:   str = `+${val}`; break;
      default: return;
    }
    await this._sendCommand(CMD.Subtotal, iconv.encode(str, 'cp1251'));
  }

  async _addComment(text) {
    const lines = wrapAtLength(text, this.info.CommentTextMaxLength || 30);
    for (const line of lines) {
      await this._sendCommand(CMD.FreeText, iconv.encode(line, 'cp1251'));
    }
  }

  async _addPayment(payment) {
    const typeText = this.getPaymentTypeText(payment.PaymentType);
    const amount = (payment.Amount || 0).toFixed(2);
    const str = `${typeText}\t${amount}`;
    await this._sendCommand(CMD.Payment, iconv.encode(str, 'cp1251'));
  }

  async _closeReceipt() {
    const resp = await this._sendCommand(CMD.CloseReceipt, null);
    return iconv.decode(resp || Buffer.alloc(0), 'cp1251');
  }

  async _getLastReceiptInfo() {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      const resp = await this._sendCommand(CMD.ReadLastQR, null);
      const qr = iconv.decode(resp, 'cp1251').trim();
      // Format: FM*RecNum*Date*Time*Amount or FM*RecNum*DateTime*Amount
      const parts = qr.split('*');
      if (parts.length >= 4) {
        status.FiscalMemorySerialNumber = parts[0];
        status.ReceiptNumber = parts[1];
        // Date: DDMMYY, Time: HHMMSS
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
        if (parts.length >= 5) {
          status.ReceiptAmount = parseFloat(parts[4]) || 0;
        }
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
        } else {
          await this._addItem(item);
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
        } else {
          await this._addItem(item);
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
      try { await this._sendCommand(CMD.AbortReceipt, null); } catch (_) {}
    }
    return status;
  }

  async _moneyTransfer(amount, type) {
    const str = `${type}\t${amount.toFixed(2)}`;
    const status = new DeviceStatusWithCashAmount();
    try {
      await this._sendCommand(CMD.Payment, iconv.encode(str, 'cp1251'));
      status.Amount = amount;
    } catch (e) {
      status.addError('E300', e.message);
    }
    return status;
  }

  async printMoneyDeposit(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    return this._moneyTransfer(transferAmount.Amount, '+');
  }

  async printMoneyWithdraw(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    return this._moneyTransfer(transferAmount.Amount, '-');
  }

  async printZReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.PrintDailyReport, iconv.encode('Z', 'cp1251'));
    } catch (e) {
      status.addError('E400', e.message);
    }
    return status;
  }

  async printXReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.PrintDailyReport, iconv.encode('X', 'cp1251'));
    } catch (e) {
      status.addError('E401', e.message);
    }
    return status;
  }

  async printDuplicate(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.PrintLastDuplicate, null);
    } catch (e) {
      status.addError('E500', e.message);
    }
    return status;
  }

  async reset(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._sendCommand(CMD.AbortReceipt, null);
    } catch (e) {
      status.addError('E600', e.message);
    }
    return status;
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
}

module.exports = { BgZfpFiscalPrinter, CMD };
