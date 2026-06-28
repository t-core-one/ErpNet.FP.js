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
  Subtotal:                   0x33,
  PrintDailyReport:           0x7C,
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
      const parts = str.split(',');
      if (parts.length > 0) status.Amount = parseFloat(parts[0]) || 0;
    } catch (e) {
      status.addError('E003', e.message);
    }
    return status;
  }

  _formatDateTimeForReceipt(dt) {
    const pad2 = n => String(n).padStart(2, '0');
    return `${pad2(dt.getDate())}${pad2(dt.getMonth() + 1)}${String(dt.getFullYear()).slice(-2)}${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
  }

  async _openReceipt(receipt, isReversal = false, reversalReceipt = null) {
    const op = receipt.Operator || '1';
    const pass = receipt.OperatorPassword || '';
    const usn = receipt.UniqueSaleNumber || '';
    let str;
    if (isReversal && reversalReceipt) {
      const reason = this.getReversalReasonText(reversalReceipt.Reason);
      const dtStr = reversalReceipt.ReceiptDateTime
        ? this._formatDateTimeForReceipt(reversalReceipt.ReceiptDateTime) : '';
      str = `${op},${pass},${usn},S,${reversalReceipt.FiscalMemorySerialNumber || ''},${reason},${reversalReceipt.ReceiptNumber || ''},${dtStr}`;
    } else {
      str = `${op},${pass},${usn}`;
    }
    await this._sendCommand(CMD.OpenReceipt, iconv.encode(str, 'cp1251'));
  }

  async _addItem(item) {
    const taxText = this.getTaxGroupText(item.TaxGroup || TaxGroup.TaxGroup1);
    const text = withMaxLength(item.Text || '', ITEM_TEXT_MANDATORY_LENGTH);
    const paddedText = text.padEnd(ITEM_TEXT_MANDATORY_LENGTH, ' ');
    const qty = (item.Quantity || 1).toFixed(3);
    const price = (item.UnitPrice || 0).toFixed(2);
    const dept = item.Department || 0;

    if (dept > 0) {
      const fb = new FrameBuilder();
      fb.addString(paddedText);
      fb.addString(`\t${price}\t${qty}\t`);
      fb.addByte(0x80 + dept);
      await this._sendCommand(CMD.SellCorrectionDepartment, fb.build());
    } else {
      const fb = new FrameBuilder();
      fb.addString(paddedText);
      const taxBuf = iconv.encode(taxText, 'cp1251');
      fb.addByte(taxBuf[0]);
      fb.addString(`\t${price}\t${qty}`);
      await this._sendCommand(CMD.SellCorrection, fb.build());
    }

    if (item.PriceModifierType) {
      await this._applyPriceModifier(item);
    }
  }

  async _applyPriceModifier(item) {
    const val = (item.PriceModifierValue || 0).toFixed(2);
    let str;
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
    for (const line of wrapAtLength(text, this.info.CommentTextMaxLength || 30)) {
      await this._sendCommand(CMD.FreeText, iconv.encode(line, 'cp1251'));
    }
  }

  async _addPayment(payment) {
    const str = `${this.getPaymentTypeText(payment.PaymentType)}\t${(payment.Amount || 0).toFixed(2)}`;
    await this._sendCommand(CMD.Payment, iconv.encode(str, 'cp1251'));
  }

  async _getLastReceiptInfo() {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      const resp = await this._sendCommand(CMD.ReadLastQR, null);
      const qr = iconv.decode(resp, 'cp1251').trim();
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
          const hh = timeStr.length >= 6 ? parseInt(timeStr.slice(0, 2), 10) : 0;
          const mm = timeStr.length >= 6 ? parseInt(timeStr.slice(2, 4), 10) : 0;
          const ss = timeStr.length >= 6 ? parseInt(timeStr.slice(4, 6), 10) : 0;
          status.ReceiptDateTime = new Date(yr, mon, day, hh, mm, ss);
        }
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

  async printMoneyDeposit(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithCashAmount();
    try {
      await this._sendCommand(CMD.Payment, iconv.encode(`+\t${transferAmount.Amount.toFixed(2)}`, 'cp1251'));
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
      await this._sendCommand(CMD.Payment, iconv.encode(`-\t${transferAmount.Amount.toFixed(2)}`, 'cp1251'));
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
