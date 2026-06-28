import { describe, it, expect } from 'vitest';
import { BgIslFiscalPrinter } from '../../src/Drivers/BgIslFiscalPrinter.js';

const PREAMBLE   = 0x01;
const POSTAMBLE  = 0x05;
const TERMINATOR = 0x03;

const mockChannel = {
  write: async () => {},
  read: async () => Buffer.alloc(0),
  descriptor: 'test',
};

// Reusable printer instance — _buildHostFrame is pure (no IO)
const printer = new BgIslFiscalPrinter(mockChannel, null);

describe('_buildHostFrame', () => {
  it('starts with PREAMBLE and ends with TERMINATOR', () => {
    const frame = printer._buildHostFrame(0x21, 0x45, null);
    expect(frame[0]).toBe(PREAMBLE);
    expect(frame[frame.length - 1]).toBe(TERMINATOR);
  });

  it('encodes LEN as 0x20 + 4 when there is no data', () => {
    const frame = printer._buildHostFrame(0x21, 0x45, null);
    expect(frame[1]).toBe(0x24); // 0x20 + 4
  });

  it('encodes LEN as 0x20 + 4 + dataLen when data is present', () => {
    const frame = printer._buildHostFrame(0x21, 0x31, Buffer.from([0x41]));
    expect(frame[1]).toBe(0x25); // 0x20 + 4 + 1
  });

  it('places SEQ and CMD at bytes 2–3', () => {
    const frame = printer._buildHostFrame(0x25, 0x30, null);
    expect(frame[2]).toBe(0x25); // SEQ
    expect(frame[3]).toBe(0x30); // CMD
  });

  it('places POSTAMBLE immediately after CMD when no data', () => {
    const frame = printer._buildHostFrame(0x21, 0x45, null);
    expect(frame[4]).toBe(POSTAMBLE);
  });

  it('places data between CMD and POSTAMBLE', () => {
    const data = Buffer.from([0x41, 0x42]); // 'AB'
    const frame = printer._buildHostFrame(0x21, 0x31, data);
    expect(frame[4]).toBe(0x41); // data[0]
    expect(frame[5]).toBe(0x42); // data[1]
    expect(frame[6]).toBe(POSTAMBLE);
  });

  it('produces 4 BCC nibble bytes after POSTAMBLE', () => {
    const frame = printer._buildHostFrame(0x21, 0x45, null);
    // BCC bytes are in the printable ASCII range 0x30–0x3F
    for (let i = 5; i <= 8; i++) {
      expect(frame[i]).toBeGreaterThanOrEqual(0x30);
      expect(frame[i]).toBeLessThanOrEqual(0x3F);
    }
  });

  it('computes correct BCC for a command with no data', () => {
    // seq=0x21, cmd=0x45, LEN=0x24
    // BCC = 0x24 + 0x21 + 0x45 + 0x05 = 143 = 0x8F
    // nibbles: 0, 0, 8, F  →  bytes: 0x30 0x30 0x38 0x3F
    const frame = printer._buildHostFrame(0x21, 0x45, null);
    expect(Array.from(frame.slice(5, 9))).toEqual([0x30, 0x30, 0x38, 0x3F]);
  });

  it('computes correct BCC for a command with one data byte', () => {
    // seq=0x21, cmd=0x31, data=[0x41], LEN=0x25
    // BCC = 0x25 + 0x21 + 0x31 + 0x41 + 0x05 = 189 = 0xBD
    // nibbles: 0, 0, B, D  →  bytes: 0x30 0x30 0x3B 0x3D
    const frame = printer._buildHostFrame(0x21, 0x31, Buffer.from([0x41]));
    expect(Array.from(frame.slice(6, 10))).toEqual([0x30, 0x30, 0x3B, 0x3D]);
  });

  it('produces correct total frame length (no data)', () => {
    // PREAMBLE + LEN + SEQ + CMD + POSTAMBLE + 4×BCC + TERMINATOR = 10
    const frame = printer._buildHostFrame(0x21, 0x45, null);
    expect(frame.length).toBe(10);
  });

  it('produces correct total frame length (2 data bytes)', () => {
    const frame = printer._buildHostFrame(0x21, 0x31, Buffer.from([0x41, 0x42]));
    expect(frame.length).toBe(12);
  });
});

describe('_nextSeq', () => {
  it('starts at 0x21 (first call increments to 1, adds 0x20)', () => {
    const p = new BgIslFiscalPrinter(mockChannel, null);
    expect(p._nextSeq()).toBe(0x21);
  });

  it('increments monotonically', () => {
    const p = new BgIslFiscalPrinter(mockChannel, null);
    const s1 = p._nextSeq();
    const s2 = p._nextSeq();
    expect(s2).toBe(s1 + 1);
  });

  it('wraps after counter reaches 0x5F back to 0x20, then 0x21', () => {
    const p = new BgIslFiscalPrinter(mockChannel, null);
    // Counter cycles 0..0x5F (96 values); seq byte = 0x20 + counter
    // After 0x5F calls the counter is 0x5F; one more wraps it to 0 → seq = 0x20
    for (let i = 0; i < 0x5F; i++) p._nextSeq();
    expect(p._nextSeq()).toBe(0x20); // counter wraps to 0
    expect(p._nextSeq()).toBe(0x21); // then back to 1
  });
});
