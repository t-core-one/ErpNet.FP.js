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
 *   3. Some commands are executed without ever being answered: every sale line
 *      and the closing commands of a receipt with a discounted line. The 09h
 *      status ping reports the device ready (40h) while the host is still
 *      waiting for the answer. The shared send loop waits 5 s and re-sends, but
 *      by then the device has discarded the postponed receipt (it keeps one
 *      open for about 5 s without a command), so the re-sent payment is refused
 *      with "02" and nothing prints — the E100 on every discounted sale. See
 *      _sendCommand below.
 *
 * The FP-28 is not in the upstream ErpNet.FP device list — that stops at the
 * FP-24 — so none of this can be assumed to hold for other Tremol models.
 * Everything specific to it lives here; bg.zk.zfp and bg.zk.v2.zfp are
 * unchanged, and the only edit to the shared base is an opt-in hook that
 * returns null unless a subclass overrides it.
 *
 * Verified against FP-28, firmware "Вер.1.04 TRP28 К.С.E7F4" (30-06-2025),
 * ФУ ИН ZK212247, over /dev/ttyACM0 at 115200.
 */
import fs from 'fs';
import iconv from 'iconv-lite';
import { BgZfpFiscalPrinter, CMD } from '../BgZfp/BgZfpFiscalPrinter.js';
import { DeviceInfo } from '../../Core/DeviceInfo.js';
import { DeviceStatusWithDateTime } from '../../Core/DeviceStatus.js';
import { FiscalPrinterDriver } from '../../Core/FiscalPrinterDriver.js';
import { InvalidDeviceInfoException } from '../../Exceptions/InvalidDeviceInfoException.js';
import { InvalidResponseException } from '../../Exceptions/InvalidResponseException.js';
import logger from '../../logger.js';

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

// Single-byte status ping and its "ready" answer (Tremol ZFP protocol, 09h).
const PING = 0x09;
const PING_READY = 0x40;

/**
 * Waits of the send loop, in ms. Each printer takes a copy, so tests can shrink it.
 *
 * firstRead: how long an answer gets before the device is asked about it. A
 *   healthy command answers in 15-120 ms and the ping costs nothing, so there
 *   is no reason to wait anywhere near the 5 s window a postponed receipt has.
 * overall: the cap for one command, busy time included.
 */
const TIMING = { firstRead: 1000, pingRead: 300, busyRead: 200, poll: 20, overall: 60000 };
const MAX_RESENDS = 3;

// Frame tracing: on while the flag file exists in the checkout root (or while
// FP_TRACE=1), checked per command, so it is switched without a restart. It logs
// every frame to and from the device — the only way to see which command the
// firmware leaves unanswered or refuses, and in what state. Item names end up in
// the log, so leave it off in normal operation.
const TRACE_FLAG = new URL('../../../.fp-trace', import.meta.url);

function traceOn() {
  try { return process.env.FP_TRACE === '1' || fs.existsSync(TRACE_FLAG); } catch { return false; }
}

function hexOf(buf) {
  return Buffer.from(buf || []).toString('hex').replace(/(..)(?!$)/g, '$1 ');
}

function textOf(buf) {
  return iconv.decode(Buffer.from(buf || []), 'cp1251')
    .replace(/[\x00-\x1f\x7f]/g, c => `<${c.charCodeAt(0).toString(16).padStart(2, '0')}>`);
}

function hexCmd(cmd) {
  return `0x${cmd.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * The first complete reply frame in buf, or null. Single-byte ping answers
 * before it are skipped. A data frame is measured by its LEN byte
 * (STX LEN SEQ CMD data CS CS ETX, LEN = 0x20 + 3 + data); an ACK frame is
 * always ACK SEQ ERR ERR CS CS ETX.
 */
function replyFrame(buf) {
  const start = buf.findIndex(b => b === STX || b === ACK);
  if (start < 0) return null;
  if (buf[start] === ACK) {
    const end = start + MIN_ACK_FRAME + 1;
    return buf.length >= end ? buf.subarray(start, end) : null;
  }
  if (buf.length < start + 2) return null;
  const end = start + buf[start + 1] - 0x20 + 4;
  return buf.length >= end ? buf.subarray(start, end) : null;
}

const MODEL_RE = /FP-?28/i;
const SERIAL_RE = /^[A-Z]{2}[0-9]{6}$/;

export class BgTremolFp28ZfpFiscalPrinter extends BgZfpFiscalPrinter {
  constructor(channel, serviceOptions, options = null) {
    super(channel, serviceOptions, options);
    this.info.CommentTextMaxLength = 30;
    this.info.ItemTextMaxLength = 32;
    this.info.OperatorPasswordMaxLength = 6;
    this._timing = { ...TIMING };
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
   * Send a command and wait for its answer the way this firmware needs.
   *
   * The FP-28 executes some commands without answering them (see 3. above).
   * So the answer gets a second; if it has not come, the 09h ping asks whether
   * the device is still busy. While it is (41h and the other busy states) the
   * wait goes on. Once it reports ready (40h) without having answered, the same
   * frame is sent again: with the same SEQ the device replies from the command
   * it already ran instead of running it again, and the missing answer arrives
   * in a few ms. The upstream .NET driver works the same way: it pings before
   * every command and waits while the device is busy.
   *
   * A reply carrying another SEQ is a late answer to an earlier command and is
   * skipped. A refusal still throws from _interpretResponse.
   *
   * `retries` is kept for the shared signature and not used: a re-send cannot
   * run a command twice, so the only limits are MAX_RESENDS and the overall time.
   */
  async _sendCommand(cmd, data, retries = 3) {  // eslint-disable-line no-unused-vars
    const seq = this._nextSeq();
    const frame = this._buildHostFrame(seq, cmd, data);
    const t = this._timing;
    const tracing = traceOn();
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    if (tracing) {
      let shown = textOf(data);
      // OpenReceipt carries the operator password as its second field.
      if (cmd === CMD.OpenReceipt) shown = shown.replace(/^([^;]*);[^;]*/, '$1;****');
      logger.info(`[fp-trace] >> ${hexCmd(cmd)} seq=${seq} data="${shown}"`);
    }

    const readFor = async ms => {
      const until = Date.now() + ms;
      let buf = Buffer.alloc(0);
      while (Date.now() < until) {
        const chunk = await this._channel.read();
        if (chunk && chunk.length) {
          buf = Buffer.concat([buf, chunk]);
          if (replyFrame(buf)) break;
        }
        await sleep(t.poll);
      }
      return buf;
    };

    // The value a reply frame carries, or undefined when it is not the answer.
    const valueOf = reply => {
      if (tracing) {
        logger.info(`[fp-trace] << ${hexCmd(cmd)} after ${elapsed()}ms raw=[${hexOf(reply)}] text="${textOf(reply)}"`);
      }
      if (reply[reply[0] === ACK ? 1 : 2] !== seq) return undefined;
      const alt = this._interpretResponse(reply, cmd);  // throws on a refusal
      if (alt) return alt.retry ? undefined : alt.data;
      // Data frame: STX | LEN | SEQ | CMD_ECHO | data | CS[2] | ETX
      return reply.subarray(4, reply.length - 3);
    };

    let resends = 0;
    let lastState;
    await this._channel.write(frame);
    let buf = await readFor(t.firstRead);
    while (elapsed() < t.overall) {
      const reply = replyFrame(buf);
      if (reply) {
        const value = valueOf(reply);
        if (value !== undefined) return value;
        buf = buf.subarray(reply.byteOffset - buf.byteOffset + reply.length);
        if (buf.length) continue;
      }

      await this._channel.write(Buffer.from([PING]));
      const pong = await readFor(t.pingRead);
      if (replyFrame(pong)) { buf = pong; continue; }  // the answer came meanwhile

      const state = pong.length ? pong[pong.length - 1] : null;
      if (tracing && state !== lastState) {
        logger.info(`[fp-trace]    ${hexCmd(cmd)} ping after ${elapsed()}ms -> `
          + `${state === null ? 'no answer' : `0x${state.toString(16)}`}`);
      }
      lastState = state;

      if (state === PING_READY) {
        if (resends >= MAX_RESENDS) break;
        resends += 1;
        if (tracing) logger.info(`[fp-trace]    ${hexCmd(cmd)} ready without an answer, re-sending (${resends})`);
        await this._channel.write(frame);
        buf = await readFor(t.firstRead);
        continue;
      }
      buf = await readFor(t.busyRead);  // busy, or no answer to the ping: keep waiting
    }
    throw new InvalidResponseException(
      `FP-28 did not answer ZFP command ${hexCmd(cmd)} (${resends} re-sends, ${elapsed()}ms)`
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
