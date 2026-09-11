import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BgTremolFp28ZfpFiscalPrinter,
  BgTremolFp28ZfpFiscalPrinterDriver,
} from '../../src/Drivers/BgTremol/BgTremolFp28ZfpFiscalPrinter.js';
import { BgZfpFiscalPrinter, CMD } from '../../src/Drivers/BgZfp/BgZfpFiscalPrinter.js';
import { BgTremolZfpFiscalPrinter } from '../../src/Drivers/BgTremol/BgTremolZfpFiscalPrinter.js';
import { BgTremolZfpV2FiscalPrinter } from '../../src/Drivers/BgTremol/BgTremolZfpV2FiscalPrinter.js';

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
