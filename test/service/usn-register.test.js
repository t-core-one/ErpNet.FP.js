import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UsnRegister } from '../../src/Service/UsnRegister.js';

let dir;
let statePath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usn-'));
  statePath = path.join(dir, 'usn-state.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function make(opts = {}) {
  return new UsnRegister({ statePath, ...opts });
}

describe('UsnRegister.reserve', () => {
  it('formats a valid УНП: serial-operator-0000001', () => {
    const reg = make();
    const r = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k1' });
    expect(r.uniqueSaleNumber).toBe('DT970048-0001-0000001');
    expect(r.sequenceNumber).toBe(1);
    expect(r.reused).toBe(false);
  });

  it('produces УНП matching the regulatory regex', () => {
    const reg = make();
    const r = reg.reserve({ serialNumber: 'DT970048', operatorCode: 'AB12', idempotencyKey: 'k1' });
    expect(r.uniqueSaleNumber).toMatch(/^[A-Z]{2}[0-9]{6}-[A-Z0-9]{4}-[0-9]{7}$/);
  });

  it('increments monotonically per device', () => {
    const reg = make();
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'b' });
    const r = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'c' });
    expect(r.uniqueSaleNumber).toBe('DT970048-0001-0000003');
  });

  it('keeps independent counters per device', () => {
    const reg = make();
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    const other = reg.reserve({ serialNumber: 'ZK123456', operatorCode: '0001', idempotencyKey: 'a' });
    expect(other.uniqueSaleNumber).toBe('ZK123456-0001-0000001');
  });

  it('is idempotent — same key returns the same number, no increment', () => {
    const reg = make();
    const first = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k1' });
    const again = reg.reserve({ serialNumber: 'DT970048', operatorCode: '9999', idempotencyKey: 'k1' });
    expect(again.uniqueSaleNumber).toBe(first.uniqueSaleNumber);
    expect(again.reused).toBe(true);
    // A fresh key still advances from where we were.
    const next = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k2' });
    expect(next.sequenceNumber).toBe(2);
  });

  it('embeds the operator code passed at reserve time', () => {
    const reg = make();
    const r = reg.reserve({ serialNumber: 'DT970048', operatorCode: 'C3PO', idempotencyKey: 'k1' });
    expect(r.uniqueSaleNumber).toBe('DT970048-C3PO-0000001');
  });

  it('normalizes serial and operator to uppercase', () => {
    const reg = make();
    const r = reg.reserve({ serialNumber: 'dt970048', operatorCode: 'ab12', idempotencyKey: 'k1' });
    expect(r.uniqueSaleNumber).toBe('DT970048-AB12-0000001');
  });

  it('rejects an invalid serial', () => {
    const reg = make();
    expect(() => reg.reserve({ serialNumber: 'BADSERIAL', operatorCode: '0001', idempotencyKey: 'k' }))
      .toThrow(/serial/i);
  });

  it('rejects an invalid operator code', () => {
    const reg = make();
    expect(() => reg.reserve({ serialNumber: 'DT970048', operatorCode: 'TOO-LONG', idempotencyKey: 'k' }))
      .toThrow(/operator/i);
  });

  it('rejects a missing idempotency key', () => {
    const reg = make();
    expect(() => reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001' }))
      .toThrow(/idempotencyKey/i);
  });
});

describe('UsnRegister persistence (survives restart)', () => {
  it('continues the sequence after a new instance loads the state file', () => {
    const reg1 = make();
    reg1.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    reg1.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'b' });

    // Simulate a service restart.
    const reg2 = make();
    const r = reg2.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'c' });
    expect(r.uniqueSaleNumber).toBe('DT970048-0001-0000003');
  });

  it('remembers issued keys across restart (idempotent after reboot)', () => {
    const reg1 = make();
    const first = reg1.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    const reg2 = make();
    const again = reg2.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    expect(again.uniqueSaleNumber).toBe(first.uniqueSaleNumber);
    expect(again.reused).toBe(true);
  });

  it('writes the state file atomically (no leftover .tmp)', () => {
    const reg = make();
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.existsSync(`${statePath}.tmp`)).toBe(false);
  });

  it('refuses to start over a corrupt existing state file (avoids duplicate numbers)', () => {
    fs.writeFileSync(statePath, '{ this is not json', 'utf8');
    expect(() => make()).toThrow(/unreadable/i);
  });
});

describe('UsnRegister idempotency pruning', () => {
  it('forgets the oldest keys past the cap but keeps the counter', () => {
    const reg = make({ maxIssuedPerDevice: 3 });
    for (let i = 1; i <= 5; i++) {
      reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: `k${i}` });
    }
    // Counter is at 5; k1 was pruned so re-reserving mints a NEW number.
    const revived = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k1' });
    expect(revived.reused).toBe(false);
    expect(revived.sequenceNumber).toBe(6);
    // A still-remembered recent key is idempotent.
    const recent = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k5' });
    expect(recent.reused).toBe(true);
  });
});
