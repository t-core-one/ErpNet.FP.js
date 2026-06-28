import { describe, it, expect } from 'vitest';
import { toCamelCase, toPascalCase } from '../../src/Helpers/camelCase.js';

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
});

describe('toPascalCase', () => {
  it('uppercases first char of camelCase keys', () => {
    expect(toPascalCase({ amount: 100, operator: 'op' }))
      .toEqual({ Amount: 100, Operator: 'op' });
  });

  it('converts Odoo deposit payload', () => {
    expect(toPascalCase({ amount: 50, operatorPassword: 'pass' }))
      .toEqual({ Amount: 50, OperatorPassword: 'pass' });
  });

  it('converts Odoo receipt payload with nested arrays', () => {
    const input = {
      uniqueSaleNumber: 'USN',
      items: [{ text: 'Beer', unitPrice: 1.5, taxGroup: 2, quantity: 1 }],
      payments: [{ amount: 1.5 }],
    };
    expect(toPascalCase(input)).toEqual({
      UniqueSaleNumber: 'USN',
      Items: [{ Text: 'Beer', UnitPrice: 1.5, TaxGroup: 2, Quantity: 1 }],
      Payments: [{ Amount: 1.5 }],
    });
  });

  it('leaves already-PascalCase keys unchanged', () => {
    expect(toPascalCase({ Amount: 100, Ok: true }))
      .toEqual({ Amount: 100, Ok: true });
  });

  it('preserves serial-number keys whose second char is uppercase', () => {
    expect(toPascalCase({ DT970048: { model: 'FP-700' } }))
      .toEqual({ DT970048: { Model: 'FP-700' } });
  });

  it('is the inverse of toCamelCase for normal camelCase objects', () => {
    const camel = { amount: 100, operator: 'op', items: [{ text: 'Beer', unitPrice: 1.5 }] };
    expect(toPascalCase(camel)).toEqual({ Amount: 100, Operator: 'op', Items: [{ Text: 'Beer', UnitPrice: 1.5 }] });
  });

  it('returns null unchanged', () => {
    expect(toPascalCase(null)).toBeNull();
  });

  it('returns primitives unchanged', () => {
    expect(toPascalCase(42)).toBe(42);
    expect(toPascalCase('hello')).toBe('hello');
  });

  it('is the inverse of toPascalCase for normal PascalCase objects', () => {
    const pascal = { Amount: 100, Operator: 'op', Items: [{ Text: 'Beer', UnitPrice: 1.5 }] };
    expect(toCamelCase(pascal)).toEqual({ amount: 100, operator: 'op', items: [{ text: 'Beer', unitPrice: 1.5 }] });
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
