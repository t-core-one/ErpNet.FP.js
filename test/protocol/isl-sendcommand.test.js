import { describe, it, expect, vi } from 'vitest';
import { BgIslFiscalPrinter } from '../../src/Drivers/BgIslFiscalPrinter.js';

const PREAMBLE   = 0x01;
const POSTAMBLE  = 0x05;
const SEPARATOR  = 0x04;
const TERMINATOR = 0x03;

// Build a minimal valid ISL response frame.
// Structure: PREAMBLE LEN SEQ CMD_ECHO [data] [SEPARATOR status] POSTAMBLE BCC×4 TERMINATOR
function buildResponse(text = '', withSeparator = false) {
  const data = Buffer.from(text, 'binary');
  const parts = [
    Buffer.from([PREAMBLE, 0x20 + 4 + data.length + (withSeparator ? 2 : 0), 0x21, 0x30]),
    data,
  ];
  if (withSeparator) parts.push(Buffer.from([SEPARATOR, 0x00])); // status = no error
  parts.push(Buffer.from([POSTAMBLE, 0x30, 0x30, 0x30, 0x30, TERMINATOR]));
  return Buffer.concat(parts);
}

function makeMockChannel(responseBuffer) {
  let readCount = 0;
  return {
    write: vi.fn(),
    read: vi.fn().mockImplementation(() => {
      if (readCount++ === 0) return Promise.resolve(responseBuffer);
      return Promise.resolve(Buffer.alloc(0));
    }),
    descriptor: 'test',
  };
}

describe('_sendCommand', () => {
  it('writes a frame starting with PREAMBLE and ending with TERMINATOR', async () => {
    const channel = makeMockChannel(buildResponse(''));
    const printer = new BgIslFiscalPrinter(channel, null);
    await printer._sendCommand(0x45, null);
    expect(channel.write).toHaveBeenCalledOnce();
    const frame = channel.write.mock.calls[0][0];
    expect(frame[0]).toBe(PREAMBLE);
    expect(frame[frame.length - 1]).toBe(TERMINATOR);
  });

  it('encodes the command byte into the frame', async () => {
    const channel = makeMockChannel(buildResponse(''));
    const printer = new BgIslFiscalPrinter(channel, null);
    await printer._sendCommand(0x5A, null); // GetDeviceInfo
    const frame = channel.write.mock.calls[0][0];
    expect(frame[3]).toBe(0x5A);
  });

  it('returns the data bytes from a valid response', async () => {
    const channel = makeMockChannel(buildResponse('FP-700,1.0,00,00,DT970048,FM12345'));
    const printer = new BgIslFiscalPrinter(channel, null);
    const result = await printer._sendCommand(0x5A, null);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString('binary')).toBe('FP-700,1.0,00,00,DT970048,FM12345');
  });

  it('returns an empty buffer when the response has no data', async () => {
    const channel = makeMockChannel(buildResponse(''));
    const printer = new BgIslFiscalPrinter(channel, null);
    const result = await printer._sendCommand(0x3C, null); // AbortFiscalReceipt
    expect(result.length).toBe(0);
  });

  it('strips the status bytes when SEPARATOR is present', async () => {
    const channel = makeMockChannel(buildResponse('hello', true));
    const printer = new BgIslFiscalPrinter(channel, null);
    const result = await printer._sendCommand(0x30, null);
    expect(result.toString('binary')).toBe('hello');
  });

  it('encodes string data as cp1251 before sending', async () => {
    const channel = makeMockChannel(buildResponse(''));
    const printer = new BgIslFiscalPrinter(channel, null);
    await printer._sendCommand(0x31, 'Item A');
    const frame = channel.write.mock.calls[0][0];
    // 'Item A' is pure ASCII, same bytes in cp1251
    const dataInFrame = frame.slice(4, frame.length - 6); // between CMD and POSTAMBLE
    expect(dataInFrame.toString('ascii')).toBe('Item A');
  });

  it('accepts a Buffer as data without re-encoding', async () => {
    const channel = makeMockChannel(buildResponse(''));
    const printer = new BgIslFiscalPrinter(channel, null);
    const buf = Buffer.from([0xC0, 0xC1]); // Cyrillic А Б in cp1251
    await printer._sendCommand(0x31, buf);
    const frame = channel.write.mock.calls[0][0];
    const dataInFrame = frame.slice(4, 6);
    expect(dataInFrame[0]).toBe(0xC0);
    expect(dataInFrame[1]).toBe(0xC1);
  });

  it('throws InvalidResponseException after all retries return no data', async () => {
    const channel = {
      write: vi.fn(),
      read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      descriptor: 'test',
    };
    const printer = new BgIslFiscalPrinter(channel, null);
    await expect(
      printer._sendCommand(0x45, null, 1, 50) // 1 retry, 50ms timeout
    ).rejects.toThrow('No valid ISL response received after retries');
  });

  it('retries on empty response before succeeding', async () => {
    let callCount = 0;
    const goodResponse = buildResponse('OK');
    const channel = {
      write: vi.fn(),
      read: vi.fn().mockImplementation(() => {
        // First write attempt returns nothing; second succeeds
        return Promise.resolve(callCount++ < 2 ? Buffer.alloc(0) : goodResponse);
      }),
      descriptor: 'test',
    };
    const printer = new BgIslFiscalPrinter(channel, null);
    // 3 retries, 500ms per attempt — enough time for the inner loop to try a few reads
    const result = await printer._sendCommand(0x45, null, 3, 500);
    expect(result.toString('binary')).toBe('OK');
  });
});
