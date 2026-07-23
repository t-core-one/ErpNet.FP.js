import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Provider } from '../../src/Provider/Provider.js';
import { HttpTransport } from '../../src/Transports/HttpTransport.js';
import { BgSisJsonFiscalPrinterDriver } from '../../src/Drivers/BgSis/BgSisJsonFiscalPrinterDriver.js';
import { ServiceOptions } from '../../src/Configuration/ServiceOptions.js';
import { PrintJob, PrintJobAction } from '../../src/Service/PrintJob.js';
import { ItemType, TaxGroup } from '../../src/Core/Item.js';
import { PaymentType } from '../../src/Core/Payment.js';
import { ReversalReason } from '../../src/Core/ReversalReceipt.js';
import { RecipientIdentifierType } from '../../src/Core/Recipient.js';
import { createSisEmulator } from '../../tools/sis-emulator.js';

// End-to-end over real HTTP: real Provider + bg.sis.json driver + HttpTransport
// talking to the SIS device emulator. This is the exact device-facing path a
// live Odoo → ErpNet.FP.js request travels, minus the (separately tested) HTTP
// route layer.

let emu;
let printer;

const RECIPIENT = {
  Name: 'ACME EOOD',
  Identifier: '203945123',
  IdentifierType: RecipientIdentifierType.LegalRegistration,
  Address: 'ul. Vitosha 1',
  City: 'Sofia',
  VatNumber: 'BG203945123',
};

function saleItem(text, qty, price) {
  return { Type: ItemType.Sale, Text: text, Quantity: qty, UnitPrice: price, TaxGroup: TaxGroup.TaxGroup2 };
}

beforeAll(async () => {
  emu = createSisEmulator({ log: false, fdNumber: 'DT970048', fmNumber: '50170034', startCash: 0 });
  const port = await emu.listen(0);
  const provider = new Provider(new ServiceOptions())
    .register(new BgSisJsonFiscalPrinterDriver(), new HttpTransport());
  printer = await provider.connect(`bg.sis.json://localhost:${port}`);
});

afterAll(async () => {
  await emu.close();
});

describe('SIS emulator — device discovery', () => {
  it('connects and reports the emulated device info', () => {
    expect(printer.info.SerialNumber).toBe('DT970048');
    expect(printer.info.Manufacturer).toBe('SIS Technology');
    expect(printer.info.SupportsInvoice).toBe(true);
    expect(printer.info.SupportsCreditNote).toBe(true);
  });

  it('reports OK status when the device is healthy', async () => {
    const status = await printer.checkStatus();
    expect(status.Ok).toBe(true);
  });
});

describe('SIS emulator — receipts', () => {
  it('prints a fiscal receipt and returns receipt info from the QR code', async () => {
    const receipt = {
      UniqueSaleNumber: 'DT970048-0001-0000001',
      Operator: '1',
      Items: [saleItem('Coffee', 2, 1.5)],
      Payments: [{ PaymentType: PaymentType.Cash, Amount: 3.0 }],
    };
    const { receiptInfo, deviceStatus } = await new PrintJob({
      printer, action: PrintJobAction.Receipt, document: receipt,
    }).run();

    expect(deviceStatus.Ok).toBe(true);
    expect(receiptInfo.ReceiptNumber).toBeTruthy();
    expect(receiptInfo.FiscalMemorySerialNumber).toBe('50170034');
    expect(receiptInfo.ReceiptAmount).toBeCloseTo(3.0, 2);
    expect(receiptInfo.ReceiptDateTime).toBeInstanceOf(Date);
  });

  it('prints a reversal receipt (storno)', async () => {
    const storno = {
      UniqueSaleNumber: 'DT970048-0001-0000002',
      Operator: '1',
      Reason: ReversalReason.Refund,
      ReceiptNumber: '0000000001',
      ReceiptDateTime: new Date(),
      FiscalMemorySerialNumber: '50170034',
      Items: [saleItem('Coffee', 1, 1.5)],
      Payments: [],
    };
    const { deviceStatus } = await new PrintJob({
      printer, action: PrintJobAction.ReversalReceipt, document: storno,
    }).run();
    expect(deviceStatus.Ok).toBe(true);
  });

  it('rejects a receipt with a malformed УНП (driver-side validation)', async () => {
    const bad = {
      UniqueSaleNumber: 'NOT-A-USN',
      Operator: '1',
      Items: [saleItem('X', 1, 1)],
      Payments: [{ PaymentType: PaymentType.Cash, Amount: 1 }],
    };
    const { deviceStatus } = await new PrintJob({
      printer, action: PrintJobAction.Receipt, document: bad,
    }).run();
    expect(deviceStatus.Ok).toBe(false);
  });
});

describe('SIS emulator — cash drawer', () => {
  it('deposit then read balance reflects the change', async () => {
    const before = await new PrintJob({ printer, action: PrintJobAction.Cash }).run();
    const start = before.Amount || 0;

    const dep = await new PrintJob({
      printer, action: PrintJobAction.Deposit, document: { Amount: 50, Operator: '1' },
    }).run();
    expect(dep.Ok).toBe(true);

    const after = await new PrintJob({ printer, action: PrintJobAction.Cash }).run();
    expect(after.Amount).toBeCloseTo(start + 50, 2);
  });

  it('withdraw reduces the balance', async () => {
    const before = await new PrintJob({ printer, action: PrintJobAction.Cash }).run();
    const wd = await new PrintJob({
      printer, action: PrintJobAction.Withdraw, document: { Amount: 20, Operator: '1' },
    }).run();
    expect(wd.Ok).toBe(true);
    const after = await new PrintJob({ printer, action: PrintJobAction.Cash }).run();
    expect(after.Amount).toBeCloseTo((before.Amount || 0) - 20, 2);
  });
});

describe('SIS emulator — reports', () => {
  it('prints X and Z reports and a duplicate', async () => {
    for (const action of [PrintJobAction.XReport, PrintJobAction.ZReport, PrintJobAction.Duplicate]) {
      const status = await new PrintJob({ printer, action, document: {} }).run();
      expect(status.Ok).toBe(true);
    }
  });
});

describe('SIS emulator — invoice / credit note', () => {
  it('prints a fiscal invoice with a recipient and external number', async () => {
    const invoice = {
      UniqueSaleNumber: 'DT970048-0001-0000010',
      Operator: '1',
      Number: 'INV-1001',
      Recipient: RECIPIENT,
      Items: [saleItem('Consulting', 1, 100)],
      Payments: [{ PaymentType: PaymentType.Card, Amount: 100 }],
    };
    const { receiptInfo, deviceStatus } = await new PrintJob({
      printer, action: PrintJobAction.Invoice, document: invoice,
    }).run();
    expect(deviceStatus.Ok).toBe(true);
    expect(receiptInfo.InvoiceNumber).toBe('INV-1001');
    expect(receiptInfo.ReceiptNumber).toBeTruthy();
  });

  it('prints a credit note referencing the original invoice', async () => {
    const creditNote = {
      UniqueSaleNumber: 'DT970048-0001-0000011',
      Operator: '1',
      Number: 'CN-2001',
      OriginalInvoiceNumber: 'INV-1001',
      FiscalDeviceSerialNumber: 'DT970048',
      Reason: ReversalReason.Refund,
      ReceiptNumber: '0000000010',
      ReceiptDateTime: new Date(),
      FiscalMemorySerialNumber: '50170034',
      Recipient: RECIPIENT,
      Items: [saleItem('Consulting', 1, 100)],
      Payments: [],
    };
    const { receiptInfo, deviceStatus } = await new PrintJob({
      printer, action: PrintJobAction.CreditNote, document: creditNote,
    }).run();
    expect(deviceStatus.Ok).toBe(true);
    expect(receiptInfo.InvoiceNumber).toBe('CN-2001');
  });

  it('rejects an invoice without a number (SIS requires an external number)', async () => {
    const invoice = {
      UniqueSaleNumber: 'DT970048-0001-0000012',
      Operator: '1',
      Recipient: RECIPIENT,
      Items: [saleItem('Consulting', 1, 100)],
      Payments: [{ PaymentType: PaymentType.Card, Amount: 100 }],
    };
    const { deviceStatus } = await new PrintJob({
      printer, action: PrintJobAction.Invoice, document: invoice,
    }).run();
    expect(deviceStatus.Ok).toBe(false);
  });
});

describe('SIS emulator — fault injection', () => {
  it('reports a device error when paper is out, then recovers', async () => {
    emu.state.fault = { prn: 'PAPER END' };
    const bad = await printer.checkStatus();
    expect(bad.Ok).toBe(false);

    emu.state.fault = null;
    const good = await printer.checkStatus();
    expect(good.Ok).toBe(true);
  });
});
