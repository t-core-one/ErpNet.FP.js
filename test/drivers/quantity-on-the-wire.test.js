import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every driver that builds a sale line must keep IEEE-754 noise off the wire.
 *
 * This is a PROPERTY test over all drivers, discovered from disk, rather than a
 * per-driver assertion — because the same defect has now shipped twice. A POS
 * sends a weighed quantity as a float: 3.32 kg of grapes arrives as
 * 3.3200000000000003. Interpolating that into a command (`${qty}`, or
 * String(qty)) puts all 19 digits on the wire.
 *
 *   - An FP-800 answered E401 and aborted the receipt. The base driver and the
 *     P driver were fixed with formatQuantity.
 *   - The X driver, written later, reimplemented _addSale for the X series'
 *     tab-separated frame and did not carry the fix across. An FP-700X answered
 *     -112104 on 15 sales across five days. The receipt aborts mid-sale, so the
 *     customer is handed a voided slip reading zero while the POS order
 *     completes — silent, and only noticed because a cashier mentioned it.
 *
 * Each driver is free to solve it its own way (formatQuantity, toFixed(3), a
 * fixed-width encoder); this asserts the OUTCOME, not the technique, so it does
 * not force a house style on a driver whose device wants padded decimals.
 *
 * A new driver that defines _addSale is picked up here automatically. If it
 * needs stubs this harness does not provide, add them to STUBS rather than
 * excluding the driver.
 */

const DRIVERS_DIR = new URL('../../src/Drivers/', import.meta.url).pathname;

function jsFilesUnder(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return jsFilesUnder(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

/** Classes exported from a module that define their own _addSale. */
async function saleBuildersIn(file) {
  const mod = await import(file);
  return Object.entries(mod)
    .filter(([, v]) => typeof v === 'function'
      && Object.prototype.hasOwnProperty.call(v.prototype || {}, '_addSale'))
    .map(([name, cls]) => ({ name, cls, file }));
}

/** Minimum surface _addSale touches, across every driver. */
function stub(cls) {
  const p = Object.create(cls.prototype);
  p.info = {
    ItemTextMaxLength: 34,
    CommentTextMaxLength: 36,
    SupportedPaymentTypes: [],
  };
  p.getTaxGroupText = () => 'Б';
  p.getPaymentTypeText = () => '0';
  const sent = [];
  p._sendCommand = async (_cmd, data) => { sent.push(String(data ?? '')); return ''; };
  p._request = async (_cmd, data) => { sent.push(String(data ?? '')); return ''; };
  p._applyPriceModifier = async () => {};
  return { printer: p, sent };
}

// Quantities a scale and a POS actually produce. Each is a value whose shortest
// round-trip representation is clean but whose float form is not.
const NOISY = [
  { value: 1.1400000000000001, clean: '1.14' },   // the FP-800 case
  { value: 3.3200000000000003, clean: '3.32' },   // the FP-700X grapes case
  { value: 0.1 + 0.2,          clean: '0.3'  },
  { value: 2.7600000000000002, clean: '2.76' },
];

const files = jsFilesUnder(DRIVERS_DIR);
const drivers = (await Promise.all(files.map(saleBuildersIn))).flat();

describe('sale line: no IEEE-754 noise reaches the device', () => {
  it('found the drivers to check', () => {
    // Guards the discovery itself: if a refactor moves or renames things so
    // that nothing is found, this test must fail rather than silently pass.
    expect(drivers.length).toBeGreaterThanOrEqual(5);
  });

  for (const { name, cls } of drivers) {
    for (const { value, clean } of NOISY) {
      it(`${name} sends ${clean}, not ${value}`, async () => {
        const item = { Text: 'ДЕСЕРТНО ГРОЗДЕ', UnitPrice: 1.5, TaxGroup: 2 };
        const wireFor = async (quantity) => {
          const { printer, sent } = stub(cls);
          await printer._addSale({ ...item, Quantity: quantity });
          expect(sent.length).toBeGreaterThan(0);
          return sent.join('|');
        };

        const noisy = await wireFor(value);
        const exact = await wireFor(Number(clean));

        // THE POINT: float noise must not change a single byte of the frame.
        // Format-agnostic on purpose — a driver may emit "3.32", a padded
        // "3.320", or a scaled integer "000003320"; all are fine, as long as
        // the noisy input produces exactly what the clean input produces.
        expect(noisy).toBe(exact);

        // The long form must never appear literally.
        expect(noisy).not.toContain(String(value));

        // ...and the quantity must genuinely reach the frame. Without this a
        // driver that dropped the quantity altogether would satisfy the check
        // above trivially, since both runs would be equally wrong.
        const other = await wireFor(Number(clean) + 1);
        expect(noisy).not.toBe(other);
      });
    }
  }
});
