import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BgTremolFp28ZfpFiscalPrinter,
  BgTremolFp28ZfpFiscalPrinterDriver,
} from '../../src/Drivers/BgTremol/BgTremolFp28ZfpFiscalPrinter.js';
import { BgZfpFiscalPrinter, CMD } from '../../src/Drivers/BgZfp/BgZfpFiscalPrinter.js';
import { BgTremolZfpFiscalPrinter } from '../../src/Drivers/BgTremol/BgTremolZfpFiscalPrinter.js';
import { BgTremolZfpV2FiscalPrinter } from '../../src/Drivers/BgTremol/BgTremolZfpV2FiscalPrinter.js';
import logger from '../../src/logger.js';

// Every buffer below was captured from a real FP-28 (firmware Вер.1.04 TRP28
// К.С.E7F4, ФУ ИН ZK212247) over /dev/ttyACM0 at 115200. They are the evidence
// for the two protocol claims this driver exists to handle, so they are recorded
// verbatim rather than hand-written.
const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// ACK frames: ACK | SEQ | ERR[2] | CS[2] | ETX, CS = XOR(SEQ, ERR) nibble-encoded.
const ACK_OK      = hex('06 21 30 30 32 31 0a'); // X report accepted      -> ERR "00"
const ACK_ERR_02  = hex('06 23 30 32 32 31 0a'); // abort, none open       -> ERR "02"
const ACK_ERR_04  = hex('06 24 30 34 32 30 0a'); // unknown command 0x7F   -> ERR "04"
// Same shape, synthesised: the cover-open refusal of GetTaxId seen in the log.
const ACK_ERR_12  = hex('06 25 31 32 32 36 0a'); //                        -> ERR "12"
// A data frame (GetStatus), which the shared parser must keep handling.
const DATA_STATUS = hex('02 2a 21 20 80 80 80 f0 a1 80 80 3f 3a 0a');

// GetStatus (0x20) payloads, both captured from ZK212247: the only difference
// between a healthy device and one with the paper cover open is byte 1 bit 0.
const STATUS_HEALTHY    = Buffer.from([0x80, 0x80, 0x80, 0xf0, 0xa1, 0x80, 0x80]);
const STATUS_COVER_OPEN = Buffer.from([0x80, 0x81, 0x80, 0xf0, 0xa1, 0x80, 0x80]);

// Device-info payloads, as decoded from cp1251.
const VERSION = '2;866;30-06-2025 08:00;TREMOL FP28; Вер.1.04 TRP28 К.С.E7F4;';
const TAX     = '204017166    ;0;4972208;03-09-2026 15:34;';
const FD      = 'ZK212247;50273226';

const channel = descriptor => ({ write: async () => {}, read: async () => Buffer.alloc(0), descriptor });

afterEach(() => vi.restoreAllMocks());

describe('BgTremolFp28ZfpFiscalPrinter — ACK frames', () => {
  const printer = () => new BgTremolFp28ZfpFiscalPrinter(channel('t'), null);

  it('reads ERR "00" as executed with no payload', () => {
    expect(printer()._interpretResponse(ACK_OK, CMD.PrintDailyReport))
      .toEqual({ data: Buffer.alloc(0) });
  });

  it('throws on a device refusal rather than retrying it', () => {
    expect(() => printer()._interpretResponse(ACK_ERR_02, CMD.AbortReceipt))
      .toThrow(/rejected ZFP command 0x39 with error code 02/);
    expect(() => printer()._interpretResponse(ACK_ERR_04, 0x7f))
      .toThrow(/error code 04/);
    expect(() => printer()._interpretResponse(ACK_ERR_12, CMD.GetTaxId))
      .toThrow(/error code 12/);
  });

  it('leaves a data frame to the shared parser', () => {
    expect(printer()._interpretResponse(DATA_STATUS, CMD.GetStatus)).toBeNull();
  });

  it('retries rather than trusting a bad checksum', () => {
    const corrupt = Buffer.from(ACK_OK);
    corrupt[4] = 0x39; // CS high nibble no longer matches
    expect(printer()._interpretResponse(corrupt, CMD.PrintDailyReport))
      .toEqual({ retry: true });
  });

  it('retries on a truncated frame', () => {
    expect(printer()._interpretResponse(hex('06 21 30 0a'), CMD.PrintDailyReport))
      .toEqual({ retry: true });
  });
});

describe('BgTremolFp28ZfpFiscalPrinter — device info', () => {
  it('exposes the raw ReadFDNumbers response alongside version and tax id', async () => {
    const printer = new BgTremolFp28ZfpFiscalPrinter(channel('t'), null);
    vi.spyOn(printer, '_sendCommand').mockImplementation(async cmd => {
      if (cmd === CMD.Version) return Buffer.from(VERSION, 'latin1');
      if (cmd === CMD.GetTaxId) return Buffer.from(TAX, 'latin1');
      if (cmd === CMD.ReadFDNumbers) return Buffer.from(FD, 'latin1');
      return Buffer.alloc(0);
    });
    const [version, extra, fd] = await printer.getRawDeviceInfo();
    expect(version).toContain('TREMOL FP28');
    expect(extra).toContain('204017166');
    expect(fd).toBe(FD);
  });
});

describe('BgTremolFp28ZfpFiscalPrinterDriver — identity', () => {
  const connectWith = (version, fd, descriptor) => {
    vi.spyOn(BgTremolFp28ZfpFiscalPrinter.prototype, 'getRawDeviceInfo')
      .mockResolvedValue([version, `${TAX};${fd}`, fd]);
    return new BgTremolFp28ZfpFiscalPrinterDriver().connect(channel(descriptor), null);
  };

  it('takes the ФУ ИН from ReadFDNumbers, not from the Version response', async () => {
    const printer = await connectWith(VERSION, FD, 'ok');
    // Version field 0 is "2" — an internal counter. Reading the serial from
    // there fails the УНП format and blocks minting entirely.
    expect(printer.info.SerialNumber).toBe('ZK212247');
    expect(printer.info.FiscalMemorySerialNumber).toBe('50273226');
  });

  it('reports the model, maker, firmware and tax id', async () => {
    const printer = await connectWith(VERSION, FD, 'meta');
    expect(printer.info.Model).toBe('FP28');
    expect(printer.info.Manufacturer).toBe('Tremol');
    expect(printer.info.FirmwareVersion).toBe('Вер.1.04 TRP28 К.С.E7F4');
    expect(printer.info.TaxIdentificationNumber).toBe('204017166');
  });

  it('yields a serial the УНП register will accept', async () => {
    const printer = await connectWith(VERSION, FD, 'usn');
    expect(printer.info.SerialNumber).toMatch(/^[A-Z]{2}[0-9]{6}$/);
  });

  it('refuses any model that is not an FP-28', async () => {
    const other = '2;866;30-06-2025 08:00;TREMOL FP24; Вер.1.04;';
    await expect(connectWith(other, FD, 'fp24')).rejects.toThrow(/not an FP-28/);
  });

  it('accepts the model written with a hyphen', async () => {
    const hyphen = '2;866;30-06-2025 08:00;TREMOL FP-28; Вер.1.04;';
    const printer = await connectWith(hyphen, FD, 'hyphen');
    expect(printer.info.Model).toBe('FP-28');
  });

  it('refuses a device whose ReadFDNumbers carries no usable serial', async () => {
    await expect(connectWith(VERSION, '2;866', 'noserial')).rejects.toThrow(/ФУ ИН/);
  });
});

describe('the shared ZFP base is unaffected', () => {
  const owns = c => Object.prototype.hasOwnProperty.call(c.prototype, '_interpretResponse');

  it('returns null for every response shape, so the base framing is unchanged', () => {
    const base = BgZfpFiscalPrinter.prototype._interpretResponse;
    expect(base.call({}, ACK_OK, CMD.PrintDailyReport)).toBeNull();
    expect(base.call({}, DATA_STATUS, CMD.GetStatus)).toBeNull();
  });

  it('is overridden by the FP-28 driver and by nothing else', () => {
    expect(owns(BgTremolFp28ZfpFiscalPrinter)).toBe(true);
    expect(owns(BgTremolZfpFiscalPrinter)).toBe(false);
    expect(owns(BgTremolZfpV2FiscalPrinter)).toBe(false);
  });

  it('keeps its send loop for every model but the FP-28', () => {
    const ownsSend = c => Object.prototype.hasOwnProperty.call(c.prototype, '_sendCommand');
    expect(ownsSend(BgTremolFp28ZfpFiscalPrinter)).toBe(true);
    expect(ownsSend(BgTremolZfpFiscalPrinter)).toBe(false);
    expect(ownsSend(BgTremolZfpV2FiscalPrinter)).toBe(false);
  });
});

describe('BgTremolFp28ZfpFiscalPrinter — checkStatus', () => {
  const withDevice = (statusBytes, clock) => {
    const printer = new BgTremolFp28ZfpFiscalPrinter(channel('status'), null);
    vi.spyOn(printer, '_sendCommand').mockImplementation(async cmd => {
      if (cmd === CMD.GetStatus) return statusBytes;
      if (cmd === CMD.GetDateTime) return Buffer.from(clock, 'latin1');
      return Buffer.alloc(0);
    });
    return printer;
  };

  it('reports a healthy device as Ok despite the always-set informational bits', async () => {
    const status = await withDevice(STATUS_HEALTHY, '11-09-2026 15:02').checkStatus();
    expect(status.Ok).toBe(true);
    expect(status.Messages).toEqual([]);
  });

  it('fails closed when the paper cover is open', async () => {
    const status = await withDevice(STATUS_COVER_OPEN, '11-09-2026 15:02').checkStatus();
    expect(status.Ok).toBe(false);
    expect(status.Messages.map(m => m.Text)).toContain('paper cover open or out of paper');
  });

  it('parses this firmware\'s HH:MM clock, which the shared pattern never matched', async () => {
    const status = await withDevice(STATUS_HEALTHY, '11-09-2026 15:02').checkStatus();
    expect(status.DeviceDateTime).toBeInstanceOf(Date);
    expect(status.DeviceDateTime.getFullYear()).toBe(2026);
    expect(status.DeviceDateTime.getMonth()).toBe(8); // September
    expect(status.DeviceDateTime.getDate()).toBe(11);
    expect(status.DeviceDateTime.getHours()).toBe(15);
    expect(status.DeviceDateTime.getMinutes()).toBe(2);
  });

  it('still parses a clock that does carry seconds', async () => {
    const status = await withDevice(STATUS_HEALTHY, '11-09-2026 15:02:37').checkStatus();
    expect(status.DeviceDateTime.getSeconds()).toBe(37);
  });

  it('fails closed when the device will not answer at all', async () => {
    const printer = new BgTremolFp28ZfpFiscalPrinter(channel('dead'), null);
    vi.spyOn(printer, '_sendCommand').mockRejectedValue(new Error('no response'));
    const status = await printer.checkStatus();
    expect(status.Ok).toBe(false);
  });
});

// A scripted FP-28 on the other end of the channel. `answer(seq, cmd, sent)`
// gives the bytes a frame is answered with (null: none), `sent` counting the
// frames of that command so far; `ping(n)` the bytes the n-th 09h ping gets.
function fakeFp28({ answer, ping = () => [0x40] }) {
  const log = [];
  const frames = [];
  let out = Buffer.alloc(0);
  let pings = 0;
  const queue = bytes => { if (bytes) out = Buffer.concat([out, Buffer.from(bytes)]); };
  return {
    log,
    frames,
    channel: {
      descriptor: 'fake-fp28',
      write: async buf => {
        if (buf.length === 1 && buf[0] === 0x09) { log.push('ping'); queue(ping(++pings)); return; }
        const seq = buf[2], cmd = buf[3];
        frames.push(Buffer.from(buf));
        log.push(`0x${cmd.toString(16)}`);
        queue(answer(seq, cmd, log.filter(x => x === `0x${cmd.toString(16)}`).length));
      },
      read: async () => { const b = out; out = Buffer.alloc(0); return b; },
    },
  };
}

// ACK SEQ ERR ERR CS CS ETX, the frame the FP-28 answers execute-only commands with.
function ack(seq, err = '00') {
  const cs = [seq, ...Buffer.from(err, 'latin1')].reduce((a, b) => a ^ b, 0);
  return [0x06, seq, ...Buffer.from(err, 'latin1'), (cs >> 4) + 0x30, (cs & 0x0f) + 0x30, 0x0a];
}

describe('BgTremolFp28ZfpFiscalPrinter — waiting for an answer', () => {
  // Real timings are 1 s / 300 ms / 60 s; the shape of the exchange is what is tested.
  const printerOn = (device, nextSeq) => {
    const printer = new BgTremolFp28ZfpFiscalPrinter(device.channel, null);
    printer._timing = { firstRead: 15, pingRead: 8, busyRead: 4, poll: 1, overall: 400 };
    printer._seqNum = nextSeq - 0x21;
    return printer;
  };
  const SALE = Buffer.from('POS test;Б;0.50*1:-0.02', 'latin1');

  it('returns a prompt answer without pinging', async () => {
    const device = fakeFp28({ answer: () => DATA_STATUS });
    const status = await printerOn(device, 0x21)._sendCommand(CMD.GetStatus, null);
    expect(status).toEqual(STATUS_HEALTHY);
    expect(device.log).toEqual(['0x20']);
  });

  // Captured on ZK212247, 2026-09-25: sale 0x31 seq 0x32 and payment 0x35
  // seq 0x33 of the 0.48 receipt went unanswered, the ping said 40h, and the
  // re-sent frame was answered "00" at once and printed once.
  it('re-sends the same frame once the device is ready without having answered', async () => {
    const device = fakeFp28({ answer: (seq, cmd, sent) => (sent === 2 ? ack(seq) : null) });
    const printer = printerOn(device, 0x32);
    await expect(printer._sendCommand(CMD.SellCorrection, SALE)).resolves.toEqual(Buffer.alloc(0));
    expect(device.log).toEqual(['0x31', 'ping', '0x31']);
    expect(device.frames[1]).toEqual(device.frames[0]);
    expect(Buffer.from(ack(0x32))).toEqual(hex('06 32 30 30 33 32 0a'));
  });

  it('keeps waiting while the device is busy and does not re-send meanwhile', async () => {
    const device = fakeFp28({
      answer: (seq, cmd, sent) => (sent === 2 ? ack(seq) : null),
      ping: n => [n <= 3 ? 0x41 : 0x40],
    });
    await printerOn(device, 0x33)._sendCommand(CMD.Payment, Buffer.from('0;1;0.48*', 'latin1'));
    expect(device.log).toEqual(['0x35', 'ping', 'ping', 'ping', 'ping', '0x35']);
  });

  it('takes an answer that arrives together with a ping reply', async () => {
    const device = fakeFp28({ answer: () => null, ping: () => [0x41, ...ack(0x34)] });
    await printerOn(device, 0x34)._sendCommand(CMD.CloseReceipt, null);
    expect(device.log).toEqual(['0x38', 'ping']);
  });

  it('skips a late answer to an earlier command', async () => {
    const device = fakeFp28({ answer: (seq, cmd, sent) => (sent === 1 ? ack(seq - 1) : ack(seq, '02')) });
    await expect(printerOn(device, 0x35)._sendCommand(CMD.CloseReceipt, null))
      .rejects.toThrow(/0x38 with error code 02/);
    expect(device.log).toEqual(['0x38', 'ping', '0x38']);
  });

  it('fails on a refusal at once, without re-sending', async () => {
    const device = fakeFp28({ answer: seq => ack(seq, '02') });
    await expect(printerOn(device, 0x36)._sendCommand(CMD.Payment, Buffer.from('0;1;0.48*', 'latin1')))
      .rejects.toThrow(/rejected ZFP command 0x35 with error code 02/);
    expect(device.log).toEqual(['0x35']);
  });

  it('gives up after three re-sends of a frame that is never answered', async () => {
    const device = fakeFp28({ answer: () => null });
    await expect(printerOn(device, 0x37)._sendCommand(CMD.Payment, null))
      .rejects.toThrow(/did not answer ZFP command 0x35 \(3 re-sends/);
    expect(device.log.filter(x => x === '0x35')).toHaveLength(4);
  });

  it('gives up at the overall limit when the device stays silent', async () => {
    const device = fakeFp28({ answer: () => null, ping: () => null });
    await expect(printerOn(device, 0x38)._sendCommand(CMD.Payment, null))
      .rejects.toThrow(/did not answer ZFP command 0x35 \(0 re-sends/);
    expect(device.log.filter(x => x === '0x35')).toHaveLength(1);
  });
});

describe('BgTremolFp28ZfpFiscalPrinter — frame tracing', () => {
  afterEach(() => { delete process.env.FP_TRACE; });

  it('logs nothing unless switched on', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const printer = new BgTremolFp28ZfpFiscalPrinter(fakeFp28({ answer: () => DATA_STATUS }).channel, null);
    await printer._sendCommand(CMD.GetStatus, null);
    expect(info.mock.calls.filter(([m]) => String(m).includes('[fp-trace]'))).toHaveLength(0);
  });

  it('logs both directions and masks the operator password', async () => {
    process.env.FP_TRACE = '1';
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const printer = new BgTremolFp28ZfpFiscalPrinter(fakeFp28({ answer: seq => ack(seq) }).channel, null);
    await printer._sendCommand(CMD.OpenReceipt, Buffer.from('1;4711;1;1;2$ZK212247-0001-0000001', 'latin1'));
    const lines = info.mock.calls.map(([m]) => String(m));
    expect(lines[0]).toMatch(/>> 0x30 seq=\d+ data="1;\*\*\*\*;1;1;2\$ZK212247/);
    expect(lines.join('\n')).not.toContain('4711');
    expect(lines[1]).toMatch(/<< 0x30 after \d+ms raw=\[06 21 30 30 32 31 0a\]/);
  });
});
