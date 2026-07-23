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

// Fresh register with a device initialized at 0 (the normal first-run setup).
function makeInitialized(serial = 'DT970048', start = 0, opts = {}) {
  const reg = make(opts);
  reg.initializeDevice(serial, start);
  return reg;
}

describe('UsnRegister fail-closed safety (no silent reset)', () => {
  it('refuses to mint for a device that was never initialized', () => {
    const reg = make();
    expect(() =>
      reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k1' })
    ).toThrow(/not initialized/i);
  });

  it('mints only after explicit initialization', () => {
    const reg = makeInitialized('DT970048', 0);
    const r = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k1' });
    expect(r.uniqueSaleNumber).toBe('DT970048-0001-0000001');
  });

  it('KEY CASE: a lost state file does NOT reset to 0 — it fails closed', () => {
    const reg1 = makeInitialized('DT970048', 0);
    reg1.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    reg1.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'b' });

    // Simulate the state file being wiped (deleted / SD reformat / redeploy).
    fs.rmSync(statePath, { force: true });
    fs.rmSync(`${statePath}.bak`, { force: true });

    const reg2 = make();
    // Must NOT silently restart at 1 — it refuses until reseeded.
    expect(() =>
      reg2.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'c' })
    ).toThrow(/not initialized/i);
  });

  it('recovers via a forward reseed after loss (continues above the lost max)', () => {
    const reg1 = makeInitialized('DT970048', 0);
    for (const k of ['a', 'b', 'c']) {
      reg1.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: k });
    }
    fs.rmSync(statePath, { force: true });

    // Recovery: reseed to the Odoo high-water mark (3) + margin.
    const reg2 = make();
    reg2.initializeDevice('DT970048', 3 + 100);
    const r = reg2.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'd' });
    expect(r.sequenceNumber).toBe(104);
    expect(r.uniqueSaleNumber).toBe('DT970048-0001-0000104');
  });
});

describe('UsnRegister.reserve', () => {
  it('formats a valid УНП and increments monotonically', () => {
    const reg = makeInitialized('DT970048', 0);
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    const r = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'b' });
    expect(r.uniqueSaleNumber).toBe('DT970048-0001-0000002');
    expect(r.uniqueSaleNumber).toMatch(/^[A-Z]{2}[0-9]{6}-[A-Z0-9]{4}-[0-9]{7}$/);
  });

  it('is idempotent and returns a numeric sequenceNumber on reuse', () => {
    const reg = makeInitialized('DT970048', 0);
    const first = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k1' });
    const again = reg.reserve({ serialNumber: 'DT970048', operatorCode: '9999', idempotencyKey: 'k1' });
    expect(again.uniqueSaleNumber).toBe(first.uniqueSaleNumber);
    expect(again.reused).toBe(true);
    expect(again.sequenceNumber).toBe(1); // numeric, not the УНП string
  });

  it('keeps independent counters per device', () => {
    const reg = makeInitialized('DT970048', 0);
    reg.initializeDevice('ZK123456', 0);
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    const other = reg.reserve({ serialNumber: 'ZK123456', operatorCode: '0001', idempotencyKey: 'a' });
    expect(other.uniqueSaleNumber).toBe('ZK123456-0001-0000001');
  });

  it('rejects invalid serial / operator / missing key', () => {
    const reg = makeInitialized('DT970048', 0);
    expect(() => reg.reserve({ serialNumber: 'BAD', operatorCode: '0001', idempotencyKey: 'k' })).toThrow(/serial/i);
    expect(() => reg.reserve({ serialNumber: 'DT970048', operatorCode: 'TOOLONG', idempotencyKey: 'k' })).toThrow(/operator/i);
    expect(() => reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001' })).toThrow(/idempotencyKey/i);
  });
});

describe('UsnRegister.initializeDevice (init & reseed)', () => {
  it('refuses to re-initialize an initialized device without force', () => {
    const reg = makeInitialized('DT970048', 0);
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    expect(() => reg.initializeDevice('DT970048', 500)).toThrow(/already initialized/i);
  });

  it('reseeds forward with force', () => {
    const reg = makeInitialized('DT970048', 0);
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    reg.initializeDevice('DT970048', 500, { force: true });
    const r = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'b' });
    expect(r.sequenceNumber).toBe(501);
  });

  it('is forward-only: refuses to lower the counter unless allowDecrease', () => {
    const reg = makeInitialized('DT970048', 100);
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' }); // 101
    expect(() => reg.initializeDevice('DT970048', 50, { force: true })).toThrow(/lower/i);
    // Explicit override is allowed (logged).
    expect(() => reg.initializeDevice('DT970048', 50, { force: true, allowDecrease: true })).not.toThrow();
  });

  it('rejects an out-of-range startSequence', () => {
    const reg = make();
    expect(() => reg.initializeDevice('DT970048', -1)).toThrow(/startSequence/i);
    expect(() => reg.initializeDevice('DT970048', 99999999)).toThrow(/startSequence/i);
  });
});

describe('UsnRegister persistence & durability', () => {
  it('continues the sequence after a restart (state reloaded)', () => {
    const reg1 = makeInitialized('DT970048', 0);
    reg1.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    reg1.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'b' });
    const reg2 = make(); // reload
    expect(reg2.isDeviceInitialized('DT970048')).toBe(true);
    const r = reg2.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'c' });
    expect(r.sequenceNumber).toBe(3);
  });

  it('reports the current counter and remembered-key count (monitoring)', () => {
    const reg = makeInitialized('DT970048', 40);
    expect(reg.current('DT970048')).toBe(40);
    expect(reg.issuedCount('DT970048')).toBe(0);
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'b' });
    expect(reg.current('DT970048')).toBe(42);
    expect(reg.issuedCount('DT970048')).toBe(2);
    // Unknown device: safe zeros, no throw.
    expect(reg.current('ZZ999999')).toBe(0);
    expect(reg.issuedCount('ZZ999999')).toBe(0);
  });

  it('remembers issued keys across restart (idempotent after reboot)', () => {
    const reg1 = makeInitialized('DT970048', 0);
    const first = reg1.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    const reg2 = make();
    const again = reg2.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    expect(again.uniqueSaleNumber).toBe(first.uniqueSaleNumber);
    expect(again.reused).toBe(true);
  });

  it('writes atomically and keeps a .bak snapshot; no leftover .tmp', () => {
    const reg = makeInitialized('DT970048', 0);
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'a' });
    reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'b' });
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.existsSync(`${statePath}.tmp`)).toBe(false);
    expect(fs.existsSync(`${statePath}.bak`)).toBe(true); // prior state snapshot
  });
});

describe('UsnRegister load-time fail-closed', () => {
  it('refuses to start over an unparseable state file', () => {
    fs.writeFileSync(statePath, '{ this is not json', 'utf8');
    expect(() => make()).toThrow(/corrupt|unreadable/i);
  });

  it('refuses to start over a valid-JSON-but-wrong-shape file (no silent reset)', () => {
    fs.writeFileSync(statePath, JSON.stringify({ foo: 'bar' }), 'utf8');
    expect(() => make()).toThrow(/unexpected shape|corrupt/i);
  });

  it('treats a genuinely absent file as "not initialized", not a fresh 0', () => {
    // No file written at all.
    const reg = make();
    expect(reg.isDeviceInitialized('DT970048')).toBe(false);
    expect(() =>
      reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k' })
    ).toThrow(/not initialized/i);
  });
});

describe('UsnRegister idempotency pruning', () => {
  it('forgets the oldest keys past the cap but keeps the counter (gap, not dup)', () => {
    const reg = makeInitialized('DT970048', 0, { maxIssuedPerDevice: 3 });
    for (let i = 1; i <= 5; i++) {
      reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: `k${i}` });
    }
    const revived = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k1' });
    expect(revived.reused).toBe(false);
    expect(revived.sequenceNumber).toBe(6); // new number, monotonic — no duplicate
    const recent = reg.reserve({ serialNumber: 'DT970048', operatorCode: '0001', idempotencyKey: 'k5' });
    expect(recent.reused).toBe(true);
  });
});
