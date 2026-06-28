import { describe, it, expect } from 'vitest';
import { toCamelCase } from '../../src/Helpers/camelCase.js';

describe('toCamelCase', () => {
  it('lowercases first char of PascalCase keys', () => {
    expect(toCamelCase({ Ok: true, Messages: [] }))
      .toEqual({ ok: true, messages: [] });
  });

  it('preserves serial-number keys whose second char is uppercase', () => {
    expect(toCamelCase({ DT970048: { Model: 'FP-700' } }))
      .toEqual({ DT970048: { model: 'FP-700' } });
  });

  it('preserves all-caps acronym keys', () => {
    expect(toCamelCase({ URI: 'http://example.com' }))
      .toEqual({ URI: 'http://example.com' });
  });

  it('leaves already-camelCase keys unchanged', () => {
    expect(toCamelCase({ version: '1.0', serverId: 'abc' }))
      .toEqual({ version: '1.0', serverId: 'abc' });
  });

  it('recurses into nested objects', () => {
    expect(toCamelCase({ Messages: [{ Type: 'error', Code: 'E001', Text: 'oops' }] }))
      .toEqual({ messages: [{ type: 'error', code: 'E001', text: 'oops' }] });
  });

  it('handles arrays at the top level', () => {
    expect(toCamelCase([{ Ok: true }, { Ok: false }]))
      .toEqual([{ ok: true }, { ok: false }]);
  });

  it('passes Date objects through without enumerating them to {}', () => {
    const d = new Date('2024-01-01T00:00:00.000Z');
    expect(toCamelCase({ DeviceDateTime: d })).toEqual({ deviceDateTime: d });
  });

  it('returns null unchanged', () => {
    expect(toCamelCase(null)).toBeNull();
  });

  it('returns primitives unchanged', () => {
    expect(toCamelCase(42)).toBe(42);
    expect(toCamelCase('hello')).toBe('hello');
    expect(toCamelCase(true)).toBe(true);
  });

  it('converts multi-level PascalCase object', () => {
    const result = toCamelCase({
      Ok: true,
      Messages: [],
      ReceiptNumber: '1234',
      ReceiptDateTime: null,
      ReceiptAmount: 10.5,
      FiscalMemorySerialNumber: 'FM12345678',
    });
    expect(result).toMatchObject({
      ok: true,
      messages: [],
      receiptNumber: '1234',
      receiptDateTime: null,
      receiptAmount: 10.5,
      fiscalMemorySerialNumber: 'FM12345678',
    });
  });
});
