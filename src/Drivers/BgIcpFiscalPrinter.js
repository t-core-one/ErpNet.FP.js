import iconv from 'iconv-lite';
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
const STX  = 0x02;
const ETX  = 0x03;
const ACK  = 0x06;
const NACK = 0x15;
const WAIT = 0x05;

// ─── Status bits ──────────────────────────────────────────────────────────
const STATUS_BITS = [
  // Byte 0
  [null, null, null, null, null, null, null, null],
  // Byte 1
  ['Fiscal memory full', 'Fiscal memory almost full', null, 'RAM reset', null, null, null, null],
  // Byte 2
  ['Clock problem', null, null, null, null, null, null, null],
  // Byte 3
  [null, null, null, null, null, null, null, null],
  // Byte 4
  ['Receipt open', 'Non-fiscal receipt open', null, null, null, null, null, null],
  // Byte 5
  [null, null, null, null, null, null, null, null],
];

function icpDecimal(value, intDigits, fracDigits) {
  const str = Math.abs(value).toFixed(fracDigits).replace('.', '');
  return str.padStart(intDigits + fracDigits, '0');
}

export class BgIcpFiscalPrinter extends BgFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this._deviceNo = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    this.info.ItemTextMaxLength = 40;

    this.paymentTypeMappings = {
      [PaymentType.Cash]: 'P',
      [PaymentType.Card]: 'C',
      [PaymentType.Check]: 'N',
      [PaymentType.Reserved1]: 'D',
    };
  }

  getTaxGroupText(taxGroup) {
    const map = {
      [TaxGroup.TaxGroup1]: 'A',
      [TaxGroup.TaxGroup2]: 'B',
      [TaxGroup.TaxGroup3]: 'C',
      [TaxGroup.TaxGroup4]: 'D',
    };
    return map[taxGroup] || 'A';
  }

  // ─── Frame I/O ──────────────────────────────────────────────────────────

  _buildFrame(hexCmd, dataStr = '') {
    const cmdBytes = Buffer.from(hexCmd, 'hex');
    const dataBytes = dataStr ? iconv.encode(dataStr, 'cp1251') : Buffer.alloc(0);
    const payload = Buffer.concat([this._deviceNo, cmdBytes, dataBytes]);

    const lenBytes = Buffer.from([
      (payload.length >> 8) & 0xFF,
      payload.length & 0xFF,
    ]);

    let cs = 0;
    for (const b of payload) cs += b;
    for (const b of lenBytes) cs += b;
    cs &= 0xFFFF;

    const csBytes = Buffer.from([
      (cs >> 8) & 0xFF,
      cs & 0xFF,
    ]);

    return Buffer.concat([
      Buffer.from([STX]),
      payload,
      lenBytes,
      csBytes,
      Buffer.from([ETX]),
    ]);
  }

  async _parseRawResponse(response) {
    if (!response || response.length === 0) return Buffer.alloc(0);
    const stxIdx = response.indexOf(STX);
    const etxIdx = response.lastIndexOf(ETX);
    if (stxIdx < 0 || etxIdx <= stxIdx) return Buffer.alloc(0);

    // Frame: STX deviceNo(4) data LEN(2) CS(2) ETX
    // DeviceNo is 4 bytes after STX
    const dataStart = stxIdx + 1 + 4;
    const dataEnd = etxIdx - 4; // before LEN(2) CS(2)
    if (dataEnd <= dataStart) return Buffer.alloc(0);
    return response.slice(dataStart, dataEnd);
  }

  async _sendRaw(hexCmd, dataStr = '', retries = 3) {
    const frame = this._buildFrame(hexCmd, dataStr);

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

      if (response.length > 0) {
        return await this._parseRawResponse(response);
      }
    }
    throw new InvalidResponseException('No valid ICP response');
  }

  async _request(hexCmd, dataStr = '') {
    const result = await this._sendRaw(hexCmd, dataStr);
    // After each command, get status
    await this._getStatus();
    return result;
  }

  async _getStatus() {
    try {
      const resp = await this._sendRaw('F80C', '');
      return resp;
    } catch (e) {
      return Buffer.alloc(0);
    }
  }

  async getRawDeviceInfo() {
    // Initialize
    await this._request('00', '');
    const infoResp = await this._request('F807', '');
    const info = iconv.decode(infoResp || Buffer.alloc(0), 'cp1251');

    const dtResp = await this._request('F3', '');
    const dt = iconv.decode(dtResp || Buffer.alloc(0), 'cp1251');

    const fmResp = await this._request('F0', '');
    const fm = iconv.decode(fmResp || Buffer.alloc(0), 'cp1251');

    return `${info}\t${fm}`;
  }

  async rawRequest(requestFrame) {
    const status = new DeviceStatusWithRawResponse();
    try {
      const raw = requestFrame.RawRequest || '';
      const sepIdx = raw.indexOf(';');
      const hexCmd = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
      const data = sepIdx >= 0 ? raw.slice(sepIdx + 1) : '';
      const resp = await this._request(hexCmd, data);
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
      const resp = await this._request('F3', '');
      const str = iconv.decode(resp, 'cp1251').trim();
      // Format: "DDMMYYHHmmSS" or similar
      if (str.length >= 12) {
        const day = parseInt(str.slice(0, 2), 10);
        const mon = parseInt(str.slice(2, 4), 10) - 1;
        const yr = 2000 + parseInt(str.slice(4, 6), 10);
        const hh = parseInt(str.slice(6, 8), 10);
        const mm = parseInt(str.slice(8, 10), 10);
        const ss = parseInt(str.slice(10, 12), 10);
        status.DeviceDateTime = new Date(yr, mon, day, hh, mm, ss);
      }
    } catch (e) {
      status.addError('E001', e.message);
    }
    return status;
  }

  async setDateTime(datetime) {
    const dt = datetime.DeviceDateTime || new Date();
    const pad2 = n => String(n).padStart(2, '0');
    const str = `${pad2(dt.getDate())}${pad2(dt.getMonth() + 1)}${String(dt.getFullYear()).slice(-2)}${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
    const status = new DeviceStatusWithDateTime();
    try {
      await this._request('73', str);
      status.DeviceDateTime = dt;
    } catch (e) {
      status.addError('E002', e.message);
    }
    return status;
  }

  async cash() {
    const status = new DeviceStatusWithCashAmount();
    try {
      const resp = await this._request('F80D', '');
      const str = iconv.decode(resp, 'cp1251');
      // Parse cash amount from response
      status.Amount = parseFloat(str.trim()) || 0;
    } catch (e) {
      status.addError('E003', e.message);
    }
    return status;
  }

  async _openReceipt(receipt) {
    const op = receipt.Operator || '1';
    const usn = receipt.UniqueSaleNumber || '';
    await this._request('44', `${op},${usn},0`);
  }

  async _openReversalReceipt(reversalReceipt) {
    const op = reversalReceipt.Operator || '1';
    const usn = reversalReceipt.UniqueSaleNumber || '';
    const receiptNum = reversalReceipt.ReceiptNumber || '';
    const fmSerial = reversalReceipt.FiscalMemorySerialNumber || '';
    const reason = this._getIcpReversalReason(reversalReceipt.Reason);
    const dtStr = reversalReceipt.ReceiptDateTime
      ? this._formatDt(reversalReceipt.ReceiptDateTime) : '';
    await this._request('24', `${op},${usn},0,${fmSerial},${reason},${receiptNum},${dtStr}`);
  }

  _getIcpReversalReason(reason) {
    switch (reason) {
      case 1: return 'R'; // OperatorError
      case 2: return 'S'; // Refund
      case 3: return 'V'; // TaxBaseReduction
      default: return 'R';
    }
  }

  _formatDt(dt) {
    const pad2 = n => String(n).padStart(2, '0');
    return `${pad2(dt.getDate())}${pad2(dt.getMonth() + 1)}${String(dt.getFullYear()).slice(-2)}${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
  }

  async _addSale(item) {
    const taxText = this.getTaxGroupText(item.TaxGroup || TaxGroup.TaxGroup1);
    const text = withMaxLength(item.Text || '', this.info.ItemTextMaxLength || 40);
    const qty = icpDecimal(item.Quantity || 1, 6, 3);
    const price = icpDecimal(item.UnitPrice || 0, 8, 2);
    const dept = item.Department || 0;

    const cmd = dept > 0 ? '47' : '44';
    const str = dept > 0
      ? `${text},${taxText},${qty},${price},${dept}`
      : `${text},${taxText},${qty},${price}`;

    await this._request(cmd, str);

    if (item.PriceModifierType !== PriceModifierType.None) {
      await this._applyPriceModifier(item);
    }
  }

  async _applyPriceModifier(item) {
    const val = icpDecimal(item.PriceModifierValue || 0, 8, 2);
    let cmd, str;
    switch (item.PriceModifierType) {
      case PriceModifierType.DiscountPercent:   cmd = '46'; str = `-%${val}`; break;
      case PriceModifierType.DiscountAmount:    cmd = '46'; str = `-${val}`; break;
      case PriceModifierType.SurchargePercent:  cmd = '46'; str = `+%${val}`; break;
      case PriceModifierType.SurchargeAmount:   cmd = '46'; str = `+${val}`; break;
      default: return;
    }
    await this._request(cmd, str);
  }

  async _addComment(text) {
    const lines = wrapAtLength(text, this.info.CommentTextMaxLength || 38);
    for (const line of lines) {
      await this._request('81', line);
    }
  }

  async _addPayment(payment) {
    const typeText = this.getPaymentTypeText(payment.PaymentType);
    const amount = icpDecimal(payment.Amount || 0, 8, 2);
    await this._request('49', `${typeText}${amount}`);
  }

  async _fullPayment() {
    await this._request('490', '');
  }

  async _closeReceipt() {
    // ICP: full payment + close happens via payment commands
    await this._sendRaw('450', '');
  }

  async _getLastReceiptInfo() {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      const resp = await this._request('F801', '');
      const str = iconv.decode(resp || Buffer.alloc(0), 'cp1251').trim();
      // Parse receipt number and amount
      const parts = str.split(',');
      if (parts.length >= 2) {
        status.ReceiptNumber = parts[0].trim();
        status.ReceiptAmount = parseFloat(parts[1]) || 0;
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
      const info = await this._getLastReceiptInfo();
      Object.assign(status, info);
    } catch (e) {
      status.addError('E100', e.message);
      try { await this._request('450', ''); } catch (_) {}
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
      const info = await this._getLastReceiptInfo();
      Object.assign(status, info);
    } catch (e) {
      status.addError('E200', e.message);
      try { await this._request('450', ''); } catch (_) {}
    }
    return status;
  }

  async printMoneyDeposit(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    const status = new DeviceStatusWithCashAmount();
    try {
      const amount = icpDecimal(transferAmount.Amount, 8, 2);
      await this._request('61', `+${amount}`);
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
      const amount = icpDecimal(transferAmount.Amount, 8, 2);
      await this._request('61', `-${amount}`);
      status.Amount = transferAmount.Amount;
    } catch (e) {
      status.addError('E300', e.message);
    }
    return status;
  }

  async printZReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._request('510', '');
    } catch (e) {
      status.addError('E400', e.message);
    }
    return status;
  }

  async printXReport(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._request('511', '');
    } catch (e) {
      status.addError('E401', e.message);
    }
    return status;
  }

  async printDuplicate(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._request('6D', '');
    } catch (e) {
      status.addError('E500', e.message);
    }
    return status;
  }

  async reset(credentials) {
    const status = new DeviceStatusWithReceiptInfo();
    try {
      await this._request('450', '');
    } catch (e) {
      status.addError('E600', e.message);
    }
    return status;
  }
}

export { icpDecimal };
