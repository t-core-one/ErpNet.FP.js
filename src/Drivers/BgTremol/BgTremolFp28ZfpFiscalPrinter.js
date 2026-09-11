/**
 * Tremol FP-28 (ZFP over USB CDC-ACM).
 *
 * A driver of its own rather than a branch inside bg.zk.zfp, because this
 * firmware differs from the ZFP devices that driver was written against in two
 * ways that must not be generalised to the rest of the family:
 *
 *   1. Execute-only commands (report, receipt, payment, cash in/out, abort)
 *      answer with a bare ACK frame
 *          ACK | SEQ | ERR[2] | CS[2] | ETX
 *      instead of a data frame. ERR "00" means the command ran; the refusals
 *      observed on this firmware are "02" (not valid in the current state) and
 *      "04" (unknown command). The shared parser looks for STX only, so it
 *      discards an ACK, retries the command three times and then reports a
 *      failure the device never had — three daily closures for one Z report.
 *
 *   2. The Version response (0x21) carries no serial:
 *          "2;866;30-06-2025 08:00;TREMOL FP28; Вер.1.04 TRP28 К.С.E7F4;"
 *      field 0 is an internal counter. The ФУ ИН and the fiscal memory number
 *      come from ReadFDNumbers (0x60): "ZK212247;50273226". Reading the serial
 *      from Version gives the device an identity of "2", which fails the УНП
 *      serial format and blocks minting outright.
 *
 * The FP-28 is not in the upstream ErpNet.FP device list — that stops at the
 * FP-24 — so neither shape can be assumed to hold for other Tremol models.
 * Everything specific to it lives here; bg.zk.zfp and bg.zk.v2.zfp are
 * unchanged, and the only edit to the shared base is an opt-in hook that
 * returns null unless a subclass overrides it.
 *
 * Verified against FP-28, firmware "Вер.1.04 TRP28 К.С.E7F4" (30-06-2025),
 * ФУ ИН ZK212247, over /dev/ttyACM0 at 115200.
 */
import iconv from 'iconv-lite';
import { BgZfpFiscalPrinter, CMD } from '../BgZfp/BgZfpFiscalPrinter.js';
import { DeviceInfo } from '../../Core/DeviceInfo.js';
import { DeviceStatusWithDateTime } from '../../Core/DeviceStatus.js';
import { FiscalPrinterDriver } from '../../Core/FiscalPrinterDriver.js';
import { InvalidDeviceInfoException } from '../../Exceptions/InvalidDeviceInfoException.js';
import { InvalidResponseException } from '../../Exceptions/InvalidResponseException.js';

const DRIVER_NAME = 'bg.zk.fp28.zfp';
const STX = 0x02;
const ACK = 0x06;
const ETX = 0x0A;
// Shortest well-formed ACK frame: ACK SEQ ERR ERR CS CS ETX -> ETX at ackIdx+6.
const MIN_ACK_FRAME = 6;
/**
 * Hard failures in the FP-28 status field, as [byteIndex, bit, message].
 *
 * DELIBERATELY CONSERVATIVE, in the spirit of the ISL table. Each status byte
 * carries 0x80 as a marker plus 7 flag bits, and a healthy FP-28 answers
 *     80 80 80 f0 a1 80 80
 * so bytes 3 and 4 already have several bits set as ordinary informational
 * state. Treating "any bit set" as a fault would fail every operation. Only
 * bits observed to change with a real fault are listed: opening the paper cover
 * on ZK212247 flipped byte 1 bit 0 and left every other bit untouched.
 */
const STATUS_ERROR_BITS = [
  [1, 0, 'paper cover open or out of paper'],
];

const MODEL_RE = /FP-?28/i;
const SERIAL_RE = /^[A-Z]{2}[0-9]{6}$/;

export class BgTremolFp28ZfpFiscalPrinter extends BgZfpFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this.info.CommentTextMaxLength = 30;
    this.info.ItemTextMaxLength = 32;
    this.info.OperatorPasswordMaxLength = 6;
  }

  getDefaultOptions() {
    return { 'Operator.ID': '1', 'Operator.Password': '0000' };
  }

  /** Reads the FP-28's ACK frame. Only this driver overrides the hook. */
  _interpretResponse(response, cmd) {
    const stxIdx = response.indexOf(STX);
    const ackIdx = response.indexOf(ACK);
    // A data frame, or an ACK byte that is really payload inside one: leave it
    // to the shared parser.
    if (ackIdx < 0 || (stxIdx >= 0 && stxIdx < ackIdx)) return null;

    const etxIdx = response.indexOf(ETX, ackIdx);
    if (etxIdx < ackIdx + MIN_ACK_FRAME) return { retry: true };

    const body = response.slice(ackIdx + 1, etxIdx - 2); // SEQ + ERR
    let cs = 0;
    for (const b of body) cs ^= b;
    const csOk = response[etxIdx - 2] === ((cs >> 4) + 0x30)
              && response[etxIdx - 1] === ((cs & 0x0f) + 0x30);
    if (!csOk) return { retry: true };

    const errCode = body.slice(1).toString('latin1');
    if (/^0+$/.test(errCode)) return { data: Buffer.alloc(0) }; // ran, no payload

    // The device parsed the frame and refused it. Retrying only repeats the
    // refusal, and would re-run anything already applied, so fail here and
    // surface the device's own code rather than a generic timeout.
    throw new InvalidResponseException(
      `FP-28 rejected ZFP command 0x${cmd.toString(16).toUpperCase().padStart(2, '0')} `
      + `with error code ${errCode}`
    );
  }

  /**
   * A readiness check that actually reads the device.
   *
   * The shared implementation only asks the clock, so it answers Ok for a device
   * that physically cannot print. plana_pos_fiscal uses this as its pre-payment
   * gate, so a cashier could finalise a sale, mint the УНП and get no receipt —
   * the check failed open. ISL escapes this because its status bytes ride every
   * response frame; ZFP carries none, so the condition has to be asked for
   * explicitly with GetStatus (0x20).
   */
  async checkStatus() {
    const status = new DeviceStatusWithDateTime();
    try {
      const raw = await this._sendCommand(CMD.GetStatus, null);
      const bytes = [...(raw || Buffer.alloc(0))];
      for (const [idx, bit, message] of STATUS_ERROR_BITS) {
        if (idx < bytes.length && (bytes[idx] & 0x7f) & (1 << bit)) {
          status.addError('E004', message);
        }
      }
    } catch (e) {
      status.addError('E001', e.message);
    }
    try {
      const resp = await this._sendCommand(CMD.GetDateTime, null);
      const str = iconv.decode(resp || Buffer.alloc(0), 'cp1251').trim();
      // This firmware answers "11-09-2026 15:02" — no seconds — which the shared
      // HH:MM:SS pattern never matched, leaving DeviceDateTime null on every call.
      const m = str.match(/(\d{2})[-./](\d{2})[-./](\d{2,4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        const yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
        status.DeviceDateTime = new Date(yr, parseInt(m[2], 10) - 1, parseInt(m[1], 10),
          parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6] || '0', 10));
      }
    } catch (e) {
      status.addError('E001', e.message);
    }
    return status;
  }

  /** As the base, plus the raw ReadFDNumbers response the FP-28 needs for its serial. */
  async getRawDeviceInfo() {
    const decode = buf => iconv.decode(buf || Buffer.alloc(0), 'cp1251').trim();
    const version = decode(await this._sendCommand(CMD.Version, null));
    const tax = decode(await this._sendCommand(CMD.GetTaxId, null));
    const fd = decode(await this._sendCommand(CMD.ReadFDNumbers, null));
    return [version, `${tax};${fd}`, fd];
  }
}

export class BgTremolFp28ZfpFiscalPrinterDriver extends FiscalPrinterDriver {
  get driverName() { return DRIVER_NAME; }

  async connect(channel, serviceOptions, autoDetect = true, options = null) {
    const printer = new BgTremolFp28ZfpFiscalPrinter(channel, serviceOptions, options);
    const cacheKey = `fp28zfp.${channel.descriptor}.${DRIVER_NAME}`;

    let raw = this.cache.get(cacheKey);
    if (!raw) {
      const [versionStr, extraStr, fdNumbersStr] = await printer.getRawDeviceInfo();
      raw = { versionStr, extraStr, fdNumbersStr };
      this.cache.store(cacheKey, raw, 30000);
    }
    printer.info = parseDeviceInfo(raw.versionStr, raw.extraStr, raw.fdNumbersStr);
    printer.info.SupportedPaymentTypes = printer.getSupportedPaymentTypes();
    printer.info.SupportsSubTotalAmountModifiers = true;
    if (serviceOptions) serviceOptions.reconfigurePrinterConstants(printer.info);
    return printer;
  }
}

function parseDeviceInfo(versionStr, extraStr, fdNumbersStr) {
  const fields = String(versionStr || '').split(';');
  if (fields.length < 4) {
    throw new InvalidDeviceInfoException(`Cannot parse FP-28 device info: ${versionStr}`);
  }

  const modelName = fields[3].trim().replace(/tremol\s*/i, '');
  // Claim an FP-28 and nothing else. The guard runs on an explicit connect as
  // well as on auto-detection, so a mistyped URI fails loudly instead of driving
  // some other Tremol with FP-28 framing assumptions.
  if (!MODEL_RE.test(modelName)) {
    throw new InvalidDeviceInfoException(
      `Model ${modelName} is not an FP-28 — use bg.zk.zfp or bg.zk.v2.zfp`
    );
  }

  const fd = String(fdNumbersStr || '').split(';');
  const serialNumber = (fd[0] || '').trim();
  const fmSerial = (fd[1] || '').trim();
  // No usable ФУ ИН means no УНП can ever be minted, so refuse the device now
  // rather than let it come up with an identity the УНП register will reject.
  if (!SERIAL_RE.test(serialNumber)) {
    throw new InvalidDeviceInfoException(
      `FP-28 ReadFDNumbers returned no usable ФУ ИН ("${fdNumbersStr}"); `
      + 'expected 2 letters followed by 6 digits'
    );
  }

  const info = new DeviceInfo();
  info.SerialNumber = serialNumber;
  info.FiscalMemorySerialNumber = fmSerial;
  info.SupportsPeriodReport = true;
  // Field 4 is the firmware version proper ("Вер.1.04 TRP28 …"); field 2 is only
  // its build date, which is what the shared parser would have reported.
  info.FirmwareVersion = (fields[4] || fields[2] || '').trim();
  info.Model = modelName;
  info.Manufacturer = 'Tremol';
  info.CommentTextMaxLength = 30;
  info.ItemTextMaxLength = 32;
  info.OperatorPasswordMaxLength = 6;
  const extra = String(extraStr || '').split(';');
  if (extra[0]) info.TaxIdentificationNumber = extra[0].trim();
  return info;
}
