import { BgFiscalPrinter } from '../BgFiscalPrinter.js';
import {
  DeviceStatus,
  DeviceStatusWithDateTime,
  DeviceStatusWithCashAmount,
} from '../../Core/DeviceStatus.js';
import { ItemType, PriceModifierType, TaxGroup } from '../../Core/Item.js';
import { PaymentType } from '../../Core/Payment.js';
import { ReversalReason } from '../../Core/ReversalReceipt.js';
import { RecipientIdentifierType } from '../../Core/Recipient.js';
import { ReceiptInfo } from '../../Core/ReceiptInfo.js';
import { InvoiceInfo } from '../../Core/InvoiceInfo.js';
import { InvalidResponseException } from '../../Exceptions/InvalidResponseException.js';
import { StandardizedStatusMessageException } from '../../Exceptions/StandardizedStatusMessageException.js';

// ─── Protocol constants ────────────────────────────────────────────────────
const MAX_BUSY_RETRIES = 5;
const BUSY_RETRY_DELAY_MS = 500;

// Only digits in positions 0..30 are allowed in comment text.
// A digit at position 31 or beyond causes device error EM_PARA_WRONG_FORMAT (0x5D).
const COMMENT_DIGIT_LIMIT = 31;

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Rounds n to `decimals` places using "round half away from zero" (matches C# MidpointRounding.AwayFromZero).
 */
function roundHalfAwayFromZero(n, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.sign(n) * Math.round(Math.abs(n) * factor) / factor;
}

/**
 * Formats a Date as the SIS storno timestamp: "ss,mm,HH;DD,MM,YY"
 */
function formatStornoDate(dt) {
  const p = n => String(n).padStart(2, '0');
  return `${p(dt.getSeconds())},${p(dt.getMinutes())},${p(dt.getHours())};${p(dt.getDate())},${p(dt.getMonth() + 1)},${String(dt.getFullYear()).slice(-2)}`;
}

/**
 * Parses a SIS receipt timestamp "ss,mm,HH;DD,MM,YY" into a Date.
 * Returns null on failure.
 */
function tryParseReceiptTimestamp(ts) {
  const parts = ts.split(';');
  if (parts.length !== 2) return null;
  const time = parts[0].split(',');
  const date = parts[1].split(',');
  if (time.length !== 3 || date.length !== 3) return null;
  try {
    const ss = parseInt(time[0], 10);
    const mm = parseInt(time[1], 10);
    const HH = parseInt(time[2], 10);
    const DD = parseInt(date[0], 10);
    const MM = parseInt(date[1], 10);
    const YY = parseInt(date[2], 10);
    const dt = new Date(2000 + YY, MM - 1, DD, HH, mm, ss);
    if (isNaN(dt.getTime())) return null;
    return dt;
  } catch (_) {
    return null;
  }
}

/**
 * Parses a QR code payload in the format FM*number*date*time*amount
 * (e.g. "51019395*0000000201*2024-11-25*11:04:30*4.75") into a ReceiptInfo.
 * Returns null when the payload is empty or does not have the expected structure.
 */
function parseQrCode(qrCode) {
  if (!qrCode) return null;
  const fields = qrCode.split('*');
  if (fields.length < 5) return null;
  const info = new ReceiptInfo();
  info.FiscalMemorySerialNumber = fields[0];
  info.ReceiptNumber = fields[1];
  // Date: "yyyy-MM-dd", Time: "HH:mm:ss" → Date constructor handles ISO-style
  const dtStr = `${fields[2]}T${fields[3]}`;
  const dt = new Date(dtStr);
  if (!isNaN(dt.getTime())) {
    info.ReceiptDateTime = dt;
  }
  const amount = parseFloat(fields[4]);
  if (!isNaN(amount)) info.ReceiptAmount = amount;
  return info;
}

/**
 * Validates that comment items (ItemType.Comment) do not contain digits beyond
 * position COMMENT_DIGIT_LIMIT. Only applies to Comment items; sale descriptions,
 * footer comments and subtotal text are exempt.
 */
function validateCommentDigits(status, receipt) {
  if (!receipt.Items) return;
  let row = 0;
  for (const item of receipt.Items) {
    row++;
    if (item.Type !== ItemType.Comment) continue;
    const text = item.Text || '';
    for (let i = COMMENT_DIGIT_LIMIT; i < text.length; i++) {
      if (/\d/.test(text[i])) {
        status.addError('E403',
          `Item ${row}: a comment line accepts digits only in the first ${COMMENT_DIGIT_LIMIT} characters`);
        break;
      }
    }
  }
}

/**
 * Computes the receipt total from items. Matches the SIS module's own total computation
 * so the fallback ReceiptInfo amount is accurate.
 */
function computeTotal(receipt) {
  let total = 0;
  if (!receipt.Items) return 0;
  for (const item of receipt.Items) {
    switch (item.Type) {
      case ItemType.Sale: {
        const quantity = !item.Quantity ? 1 : item.Quantity;
        let sum = roundHalfAwayFromZero(quantity * item.UnitPrice);
        switch (item.PriceModifierType) {
          case PriceModifierType.DiscountAmount:
            sum -= item.PriceModifierValue;
            break;
          case PriceModifierType.SurchargeAmount:
            sum += item.PriceModifierValue;
            break;
          case PriceModifierType.DiscountPercent:
            sum -= roundHalfAwayFromZero(sum * item.PriceModifierValue / 100);
            break;
          case PriceModifierType.SurchargePercent:
            sum += roundHalfAwayFromZero(sum * item.PriceModifierValue / 100);
            break;
        }
        total += sum;
        break;
      }
      case ItemType.SurchargeAmount:
        total += item.Amount;
        break;
      case ItemType.DiscountAmount:
        total -= item.Amount;
        break;
    }
  }
  return roundHalfAwayFromZero(total);
}

// ─── Printer class ─────────────────────────────────────────────────────────

export class BgSisJsonFiscalPrinter extends BgFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this._idCounter = 0;

    // SIS-specific payment type mappings (0-based medium codes)
    this.paymentTypeMappings = {
      [PaymentType.Cash]:          '0',
      [PaymentType.Bank]:          '1',
      [PaymentType.Card]:          '2',
      [PaymentType.Check]:         '3',
      [PaymentType.InternalUsage]: '4',
      [PaymentType.Coupons]:       '5',
      [PaymentType.ExtCoupons]:    '6',
      [PaymentType.Reserved1]:     '7',
      [PaymentType.Packaging]:     '8',
    };
  }

  // ─── Tax group ────────────────────────────────────────────────────────────

  /**
   * SIS enumVatCategory is 0-based: TaxGroup1 (A) = 0, TaxGroup2 (B) = 1, etc.
   * TaxGroup.Unspecified is not valid on the SIS module.
   */
  getTaxGroupText(taxGroup) {
    if (taxGroup === TaxGroup.Unspecified) {
      throw new StandardizedStatusMessageException('E411', 'error',
        `Tax group ${taxGroup} unsupported`);
    }
    return String(taxGroup - 1);
  }

  // ─── Reversal reason ────────────────────────────────────────────────────

  getReversalReasonText(reason) {
    switch (reason) {
      case ReversalReason.OperatorError:     return '0';
      case ReversalReason.Refund:            return '1';
      case ReversalReason.TaxBaseReduction:  return '2';
      default:                               return '0';
    }
  }

  // ─── PosId ───────────────────────────────────────────────────────────────

  /**
   * Returns the optional POS ID (≤6 chars). Checked first in per-printer service
   * config (PrintersProperties.<serial>.PrinterOptions.posId), then in options.
   */
  _getPosId() {
    const printerProps = this._serviceOptions
      && this.info
      && this.info.SerialNumber
      && this._serviceOptions.PrintersProperties
      && this._serviceOptions.PrintersProperties[this.info.SerialNumber];
    const fromService = printerProps && printerProps.PrinterOptions && printerProps.PrinterOptions.posId;
    const posId = fromService || (this._options && this._options.PosId) || null;
    if (!posId) return null;
    return posId.length > 6 ? posId.slice(0, 6) : posId;
  }

  // ─── JSON-RPC transport ────────────────────────────────────────────────

  /**
   * Sends a JSON-RPC request object and returns { json, raw }.
   * Retries while the device replies "BUSY". Throws on transport/parse errors so
   * that detection can skip incompatible channels.
   */
  async _rawJsonRequest(request) {
    const requestText = JSON.stringify(request);
    const requestBytes = Buffer.from(requestText, 'utf8');

    for (let attempt = 0; ; attempt++) {
      await this._channel.write(requestBytes);
      const responseBytes = await this._channel.read();
      const responseText = responseBytes.toString('utf8').trim();

      if (!responseText) {
        throw new InvalidResponseException(
          `Empty response from device for method '${request.method}'`);
      }

      let json;
      try {
        json = JSON.parse(responseText);
      } catch (e) {
        throw new InvalidResponseException(`Invalid JSON response: ${responseText}`);
      }

      // BUSY: the device is processing a previous command; back off and retry.
      if (typeof json.result === 'string' && json.result.toUpperCase() === 'BUSY') {
        if (attempt >= MAX_BUSY_RETRIES) {
          throw new Error('Device is busy (BUSY) after maximum retries');
        }
        await new Promise(r => setTimeout(r, BUSY_RETRY_DELAY_MS));
        continue;
      }

      return { json, raw: responseText };
    }
  }

  /**
   * Builds and sends a JSON-RPC request. topLevel members (e.g. period/type for
   * getData) are merged at the root, next to method/id, as the SIS spec expects.
   * Returns { json, status }. Catches transport/parse errors and converts them to
   * an E999 status so callers do not need try/catch for routine commands.
   */
  async _request(method, params = null, topLevel = null) {
    const request = {
      jsonrpc: '2.0',
      id: ++this._idCounter,
      method,
    };
    if (params !== null) request.params = params;
    if (topLevel) Object.assign(request, topLevel);

    try {
      const { json } = await this._rawJsonRequest(request);
      return { json, status: this._parseResponseStatus(json) };
    } catch (e) {
      const status = new DeviceStatus();
      status.addError('E999', e.message);
      return { json: {}, status };
    }
  }

  // ─── Response parsing ─────────────────────────────────────────────────

  /**
   * Maps a SIS response object to a DeviceStatus. Inspects the JSON-RPC error
   * object, MFC error fields, printer hardware status (prn_status), fiscal
   * controller status (mfc_status), and pending NRA blocking.
   */
  _parseResponseStatus(json) {
    const status = new DeviceStatus();

    // JSON-RPC level error object
    if (json.error && typeof json.error === 'object') {
      status.addError(json.error.code || 'E999', json.error.message || 'Unknown error');
    }

    // MFC (fiscal controller) error. Surface under E999 while preserving original detail.
    const mfcError = json.mfc_error;
    const mfcErrorMessage = json.mfc_error_message || '';
    if (mfcError && mfcError !== '0' && String(mfcError) !== '0'
        && mfcErrorMessage.toUpperCase() !== 'EM_NO_ERROR') {
      const detail = mfcErrorMessage || 'Device error';
      status.addError('E999', `MFC error ${mfcError}: ${detail}`);
    }

    // Printer hardware status (paper, cover, ...).
    if (Array.isArray(json.prn_status)) {
      const seen = new Set();
      for (const entry of json.prn_status) {
        const s = entry && entry.status;
        if (s && !seen.has(s)) {
          seen.add(s);
          this._mapPrinterStatus(status, s);
        }
      }
    }

    // Fiscal controller status (informational).
    if (Array.isArray(json.mfc_status)) {
      for (const entry of json.mfc_status) {
        const s = entry && entry.status;
        if (s) status.addInfo('I000', `MFC: ${s}`);
      }
    }

    // Pending NRA blocking.
    const reason2block = json.reason2block;
    if (reason2block && String(reason2block) !== '0') {
      const min2block = json.min2block || '';
      status.addWarning('W599',
        `Device pending NRA blocking (reason ${reason2block}, ${min2block} minutes left)`);
    }

    const lastNraErr = json.lastNRAErrNum;
    if (lastNraErr && lastNraErr !== 0) {
      status.addWarning('W599',
        `NRA error ${lastNraErr}: ${json.lastNRAErrText || ''}`);
    }

    return status;
  }

  _mapPrinterStatus(status, prnStatus) {
    switch (prnStatus.replace(/\s/g, '').toUpperCase()) {
      case 'PAPEREND':
        status.addError('E301', 'Paper end');
        break;
      case 'PAPERNEAREND':
        status.addWarning('W301', 'Paper near end');
        break;
      case 'COVEROPEN':
        status.addError('E302', 'Cover is open');
        break;
      case 'CUTTERERROR':
        status.addError('E306', 'Error in paper cutter');
        break;
      case 'AUTORECOVERABLEERROR':
        status.addWarning('W399', 'Printer reported an auto-recoverable error');
        break;
      case 'CASHDRAWEROPEN':
      case 'CASHDRAWERCLOSED':
        // Not a fault.
        break;
      default:
        status.addInfo('I001', `PRN: ${prnStatus}`);
        break;
    }
  }

  // ─── Device info helpers ─────────────────────────────────────────────

  /**
   * Calls getMfcInfo and returns { raw, status } where raw is the stringified
   * JSON response. Used by the driver at connect time to populate DeviceInfo.
   */
  async getRawDeviceInfo() {
    const request = {
      jsonrpc: '2.0',
      id: ++this._idCounter,
      method: 'getMfcInfo',
    };
    try {
      const { raw } = await this._rawJsonRequest(request);
      return { raw, status: new DeviceStatus() };
    } catch (e) {
      const status = new DeviceStatus();
      status.addError('E999', e.message);
      return { raw: '{}', status };
    }
  }

  /**
   * Calls getStatus and extracts printerModel and fwChecksum. Used by the driver
   * at connect time.
   */
  async getModelAndChecksum() {
    const { json } = await this._request('getStatus');
    return {
      model: json.printerModel || '',
      fwChecksum: json.fwChecksum || '',
    };
  }

  // ─── Validation overrides ─────────────────────────────────────────────

  validateReceipt(receipt) {
    const status = super.validateReceipt(receipt);
    if (status.Ok) {
      validateCommentDigits(status, receipt);
    }
    return status;
  }

  validateInvoice(invoice) {
    const status = super.validateInvoice(invoice);
    if (status.Ok) {
      this._validateSisRecipient(status, invoice.Recipient);
    }
    return status;
  }

  validateCreditNote(creditNote) {
    const status = super.validateCreditNote(creditNote);
    if (status.Ok) {
      this._validateSisRecipient(status, creditNote.Recipient);
      if (!creditNote.FiscalDeviceSerialNumber) {
        status.addError('E405',
          'FiscalDeviceSerialNumber of the original invoice is required by this device');
      }
    }
    return status;
  }

  /**
   * SIS-specific recipient checks: the device requires a city field, and it can
   * only encode a subset of identifier types.
   */
  _validateSisRecipient(status, recipient) {
    if (!recipient) return;
    if (!recipient.City) {
      status.addError('E405', 'Recipient "city" is required by this device');
    }
    try {
      this._getIdentifierTypeCode(recipient.IdentifierType);
    } catch (e) {
      if (e.name === 'StandardizedStatusMessageException') {
        status.addError(e.code, e.message);
      } else {
        throw e;
      }
    }
  }

  /**
   * Maps the country-neutral RecipientIdentifierType to the SIS identNumberType code:
   *   0 = BG company (EIK), 1 = BG physical person (EGN), 2 = foreign.
   * TaxNumber has no SIS equivalent and throws E412.
   */
  _getIdentifierTypeCode(identifierType) {
    switch (identifierType) {
      case RecipientIdentifierType.LegalRegistration: return 0;
      case RecipientIdentifierType.NationalId:        return 1;
      case RecipientIdentifierType.ForeignerId:       return 2;
      default:
        throw new StandardizedStatusMessageException('E412', 'error',
          `Identifier type ${identifierType} is not supported by this device`);
    }
  }

  // ─── Status commands ──────────────────────────────────────────────────

  async checkStatus() {
    const { json, status } = await this._request('getStatus');
    const statusEx = new DeviceStatusWithDateTime();
    Object.assign(statusEx, status);
    // Timestamp format: "dd-MM-yyyy HH:mm:ss"
    const timestamp = json.timestamp;
    if (timestamp) {
      const m = timestamp.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
      if (m) {
        statusEx.DeviceDateTime = new Date(
          parseInt(m[3], 10),
          parseInt(m[2], 10) - 1,
          parseInt(m[1], 10),
          parseInt(m[4], 10),
          parseInt(m[5], 10),
          parseInt(m[6], 10)
        );
      }
    }
    return statusEx;
  }

  async setDateTime(currentDateTime) {
    const dt = (currentDateTime && currentDateTime.DeviceDateTime) || new Date();
    const p = n => String(n).padStart(2, '0');
    const time = `${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())};${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${String(dt.getFullYear()).slice(-2)}`;
    const { status } = await this._request('setTime', null, { time });
    return status;
  }

  async cash(credentials) {
    const { json, status } = await this._request('getCashBalance');
    const statusEx = new DeviceStatusWithCashAmount();
    Object.assign(statusEx, status);
    const cashBalance = json.cashBalance;
    if (cashBalance != null) {
      const amount = parseFloat(cashBalance);
      if (!isNaN(amount)) statusEx.Amount = amount;
    }
    return statusEx;
  }

  // ─── Cash handling ────────────────────────────────────────────────────

  async printMoneyDeposit(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    return this._cashHandling(transferAmount.Amount, transferAmount.Operator);
  }

  async printMoneyWithdraw(transferAmount) {
    const validation = this.validateTransferAmount(transferAmount);
    if (!validation.Ok) return validation;
    if (transferAmount.Amount < 0) {
      const status = new DeviceStatus();
      status.addError('E403', 'Withdraw amount must be positive number');
      return status;
    }
    return this._cashHandling(-transferAmount.Amount, transferAmount.Operator);
  }

  async _cashHandling(amount, operator) {
    const opNum = parseInt(operator, 10);
    const begin = { operatorNumber: isNaN(opNum) ? 1 : opNum };
    const posId = this._getPosId();
    if (posId) begin.posId = posId;

    const prms = {
      beginFiscalReceiptInput: begin,
      amount: String(amount),
    };

    const { status } = await this._request('cashHandling', prms);
    return status;
  }

  // ─── Receipt printing ─────────────────────────────────────────────────

  async printReceipt(receipt) {
    const validation = this.validateReceipt(receipt);
    if (!validation.Ok) return { receiptInfo: new ReceiptInfo(), deviceStatus: validation };
    return this._printFiscalReceipt(receipt, null);
  }

  async printReversalReceipt(reversalReceipt) {
    const validation = this.validateReversalReceipt(reversalReceipt);
    if (!validation.Ok) return { receiptInfo: new ReceiptInfo(), deviceStatus: validation };
    return this._printFiscalReceipt(reversalReceipt, reversalReceipt);
  }

  async _printFiscalReceipt(receipt, reversal) {
    let prms;
    try {
      prms = this._buildReceiptParams(receipt, reversal);
    } catch (e) {
      if (e.name === 'StandardizedStatusMessageException') {
        const status = new DeviceStatus();
        status.addError(e.code, e.message);
        return { receiptInfo: new ReceiptInfo(), deviceStatus: status };
      }
      throw e;
    }
    return this._executePrint(prms, receipt, null);
  }

  // ─── Invoice / credit note printing ───────────────────────────────────

  async printInvoice(invoice) {
    const validation = this.validateInvoice(invoice);
    if (!validation.Ok) return { receiptInfo: new InvoiceInfo(), deviceStatus: validation };

    let prms;
    try {
      prms = this._buildReceiptParams(invoice, null);
      prms.invoiceData = this._buildInvoiceData(invoice);
    } catch (e) {
      if (e.name === 'StandardizedStatusMessageException') {
        const status = new DeviceStatus();
        status.addError(e.code, e.message);
        return { receiptInfo: new InvoiceInfo(), deviceStatus: status };
      }
      throw e;
    }

    return this._executePrint(prms, invoice, invoice.Number);
  }

  async printCreditNote(creditNote) {
    const validation = this.validateCreditNote(creditNote);
    if (!validation.Ok) return { receiptInfo: new InvoiceInfo(), deviceStatus: validation };

    let prms;
    try {
      prms = this._buildReceiptParams(creditNote, creditNote);
      const reversal = prms.stornoInput;

      if (!creditNote.OriginalInvoiceNumber) {
        throw new StandardizedStatusMessageException('E405', 'error',
          'OriginalInvoiceNumber of the credit note is empty');
      }
      if (!creditNote.FiscalDeviceSerialNumber) {
        throw new StandardizedStatusMessageException('E405', 'error',
          'FiscalDeviceSerialNumber of the original invoice is required by this device');
      }

      reversal.invoiceNumber = creditNote.OriginalInvoiceNumber;
      reversal.fiscDevNumber = creditNote.FiscalDeviceSerialNumber;
      prms.invoiceData = this._buildInvoiceData(creditNote);
    } catch (e) {
      if (e.name === 'StandardizedStatusMessageException') {
        const status = new DeviceStatus();
        status.addError(e.code, e.message);
        return { receiptInfo: new InvoiceInfo(), deviceStatus: status };
      }
      throw e;
    }

    return this._executePrint(prms, creditNote, creditNote.Number);
  }

  /**
   * Sends the built printReceipt request and resolves the returned receipt info.
   * When invoiceNumber is non-null the result is an InvoiceInfo carrying that number.
   */
  async _executePrint(prms, receipt, invoiceNumber) {
    const { json, status } = await this._request('printReceipt', prms);
    if (!status.Ok) {
      return { receiptInfo: new ReceiptInfo(), deviceStatus: status };
    }

    const { info, deviceStatus: enrichedStatus } = await this._enrichReceiptInfo(json, status, receipt);

    if (invoiceNumber !== null && invoiceNumber !== undefined) {
      const invoiceInfo = new InvoiceInfo();
      invoiceInfo.ReceiptNumber = info.ReceiptNumber;
      invoiceInfo.ReceiptDateTime = info.ReceiptDateTime;
      invoiceInfo.ReceiptAmount = info.ReceiptAmount;
      invoiceInfo.FiscalMemorySerialNumber = info.FiscalMemorySerialNumber;
      invoiceInfo.InvoiceNumber = invoiceNumber;
      return { receiptInfo: invoiceInfo, deviceStatus: enrichedStatus };
    }

    return { receiptInfo: info, deviceStatus: enrichedStatus };
  }

  /**
   * After a successful fiscal receipt, resolves the exact receipt number, amount,
   * date and fiscal memory number.
   *
   * Priority:
   *   1. "qrcode" field inline in the printReceipt answer (no extra round-trip).
   *   2. getData { period: "day", type: "LastQRCode" } fallback.
   *   3. Plain fields from the printReceipt answer.
   */
  async _enrichReceiptInfo(printResponse, status, receipt) {
    // Preferred: inline QR code
    const inlineInfo = parseQrCode(printResponse.qrcode);
    if (inlineInfo) return { info: inlineInfo, deviceStatus: status };

    // Fallback: explicit QR code read
    const { json: qrJson, status: qrStatus } = await this._request(
      'getData', null, { period: 'day', type: 'LastQRCode' });

    if (qrStatus.Ok) {
      const qrData = qrJson.response && qrJson.response.data;
      const qrInfo = parseQrCode(qrData);
      if (qrInfo) return { info: qrInfo, deviceStatus: status };
    }

    // Final fallback: plain fields from the printReceipt answer
    const fallback = new ReceiptInfo();
    fallback.FiscalMemorySerialNumber = this.info.FiscalMemorySerialNumber || '';
    fallback.ReceiptNumber = printResponse.grandReceiptNum || '';
    fallback.ReceiptAmount = computeTotal(receipt);

    const ts = printResponse.receiptTimestamp;
    if (ts) {
      const dt = tryParseReceiptTimestamp(ts);
      if (dt) fallback.ReceiptDateTime = dt;
    }

    return { info: fallback, deviceStatus: status };
  }

  // ─── Report commands ──────────────────────────────────────────────────

  async printZReport(credentials) {
    const { status } = await this._request('printZReport');
    return status;
  }

  async printXReport(credentials) {
    const { status } = await this._request('printXReport');
    return status;
  }

  async printDuplicate(credentials) {
    const { status } = await this._request('printDuplicate');
    return status;
  }

  async rawRequest(requestFrame) {
    let request;
    try {
      request = JSON.parse(requestFrame.RawRequest);
    } catch (_) {
      const status = new DeviceStatus();
      status.addError('E401', 'RawRequest must be a valid JSON-RPC object');
      return { RawResponse: '', ...status };
    }

    let raw = '';
    const status = new DeviceStatus();
    try {
      const result = await this._rawJsonRequest(request);
      raw = result.raw;
      Object.assign(status, this._parseResponseStatus(result.json));
    } catch (e) {
      status.addError('E999', e.message);
    }
    return { RawResponse: raw, ...status };
  }

  async reset(credentials) {
    // Per the SIS spec, getError cancels any pending/open receipt on the device.
    await this._request('getError');
    return this.checkStatus();
  }

  // ─── Receipt params builder ────────────────────────────────────────────

  /**
   * Builds the params object for the printReceipt JSON-RPC call.
   */
  _buildReceiptParams(receipt, reversal) {
    const begin = {};
    const opNum = parseInt(receipt.Operator, 10);
    if (!isNaN(opNum)) {
      begin.operatorNumber = opNum;
    } else {
      begin.operatorNumber = 1;
      if (receipt.Operator) begin.operatorName = receipt.Operator;
    }

    const posId = this._getPosId();
    if (posId) begin.posId = posId;

    if (receipt.UniqueSaleNumber) begin.usn = receipt.UniqueSaleNumber;

    const prms = { beginFiscalReceiptInput: begin };

    const freeprint = [];
    const footer = [];
    const receiptItems = [];
    const subtotal = [];
    let lastSaleItem = null;
    let anySale = false;

    if (receipt.Items) {
      for (const item of receipt.Items) {
        switch (item.Type) {
          case ItemType.Sale: {
            const saleItem = this._buildSaleItem(item);
            receiptItems.push(saleItem);
            lastSaleItem = saleItem;
            anySale = true;
            break;
          }
          case ItemType.Comment:
            if (!anySale || !lastSaleItem) {
              freeprint.push({ text: item.Text });
            } else {
              if (!lastSaleItem.textlines) lastSaleItem.textlines = [];
              lastSaleItem.textlines.push({ text: item.Text });
            }
            break;
          case ItemType.FooterComment:
            footer.push({ text: item.Text, type: 'text' });
            break;
          case ItemType.SurchargeAmount:
          case ItemType.DiscountAmount: {
            const subtotalEntry = {
              subtotalText: item.Text || '',
              subtotalSurchargeAmount: String(
                item.Type === ItemType.DiscountAmount ? -item.Amount : item.Amount),
            };
            if (item.TaxGroup !== TaxGroup.Unspecified) {
              subtotalEntry.enumVatCategory = parseInt(this.getTaxGroupText(item.TaxGroup), 10);
            } else if (this.info.SubTotalAmountModifiersRequireTaxGroup) {
              throw new StandardizedStatusMessageException('E411', 'error',
                'Subtotal amount modifier requires a taxGroup for this device');
            }
            subtotal.push(subtotalEntry);
            break;
          }
        }
      }
    }

    if (freeprint.length > 0) prms.freeprint = freeprint;
    prms.receiptItems = receiptItems;
    if (subtotal.length > 0) prms.subtotal = subtotal;

    prms.receiptPayments = this._buildPayments(receipt, reversal !== null);

    if (reversal !== null && reversal !== undefined) {
      prms.stornoInput = {
        documentDate: formatStornoDate(reversal.ReceiptDateTime || new Date()),
        enumStornoType: parseInt(this.getReversalReasonText(reversal.Reason), 10),
        fiscMemNumber: reversal.FiscalMemorySerialNumber || '',
        receiptNumber: reversal.ReceiptNumber || '',
      };
    }

    if (footer.length > 0) prms.textAfterPayment = footer;

    return prms;
  }

  /**
   * Builds the "invoiceData" client block for extended fiscal receipts (invoice / credit note).
   */
  _buildInvoiceData(document) {
    const recipient = document.Recipient;
    if (!recipient) {
      throw new StandardizedStatusMessageException('E405', 'error', 'Invoice requires a "recipient"');
    }
    if (!document.Number) {
      throw new StandardizedStatusMessageException('E405', 'error',
        'Invoice "number" is required by this device');
    }
    if (!recipient.City) {
      throw new StandardizedStatusMessageException('E405', 'error',
        'Recipient "city" is required by this device');
    }

    const data = {
      invNumber: document.Number,
      city: recipient.City,
      identNumber: recipient.Identifier,
      identNumberType: this._getIdentifierTypeCode(recipient.IdentifierType),
      recipientAddress: recipient.Address,
      recipientName: recipient.Name,
    };

    if (recipient.VatNumber) {
      data.vatIdentNumber = recipient.VatNumber;
    }

    return data;
  }

  _buildSaleItem(item) {
    const quantity = !item.Quantity ? 1 : item.Quantity;
    const jItem = {
      description: item.Text,
      enumVatCategory: parseInt(this.getTaxGroupText(item.TaxGroup), 10),
      price: String(item.UnitPrice),
      quantity: String(quantity),
    };

    if (item.Department > 0) jItem.department = item.Department;

    if (item.PriceModifierType && item.PriceModifierValue !== 0) {
      const itemSum = roundHalfAwayFromZero(quantity * item.UnitPrice);
      let amount;
      switch (item.PriceModifierType) {
        case PriceModifierType.DiscountAmount:
          amount = -item.PriceModifierValue;
          break;
        case PriceModifierType.SurchargeAmount:
          amount = item.PriceModifierValue;
          break;
        case PriceModifierType.DiscountPercent:
          amount = -roundHalfAwayFromZero(itemSum * item.PriceModifierValue / 100);
          break;
        case PriceModifierType.SurchargePercent:
          amount = roundHalfAwayFromZero(itemSum * item.PriceModifierValue / 100);
          break;
        default:
          amount = 0;
      }
      if (amount !== 0) jItem.surchargeAmount = String(amount);
    }

    return jItem;
  }

  _buildPayments(receipt, isReversal) {
    const payments = [];

    // Reversal receipts only accept cash; when no payments are given, pay the full total in cash.
    if (isReversal || !receipt.Payments || receipt.Payments.length === 0) {
      payments.push({
        amount: String(computeTotal(receipt)),
        medium: 0,
      });
      return payments;
    }

    let change = 0;
    for (const payment of receipt.Payments) {
      if (payment.PaymentType === PaymentType.Change) {
        change += -payment.Amount;
        continue;
      }
      payments.push({
        amount: String(payment.Amount),
        medium: parseInt(this.getPaymentTypeText(payment.PaymentType), 10),
      });
    }

    // Apply change to the first cash payment
    if (change > 0) {
      const cashPayment = payments.find(p => p.medium === 0);
      if (cashPayment) cashPayment.change = String(change);
    }

    return payments;
  }
}
