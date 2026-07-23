# ErpNet.FP.js

A Node.js port of [ErpNet.FP](https://github.com/erpnet/ErpNet.FP) — a lightweight HTTP server that provides a REST/JSON API for communicating with fiscal printers.

## Why this port exists

The original ErpNet.FP is written in C# and targets .NET. While it runs well on modern hardware, deploying it on **older Raspberry Pi devices** (e.g. Raspberry Pi 2) is impractical — .NET runtime performance on ARMv7 is poor and resource usage is high for a simple serial gateway workload.

This port replaces the .NET runtime with Node.js, which has excellent ARM support, low memory footprint, and official binaries for Raspberry Pi. The result is the same REST API and the same fiscal printer protocol support, running comfortably on a Raspberry Pi 3 with 1 GB of RAM.

## Compatibility

The HTTP API is fully compatible with the original ErpNet.FP server. Existing clients (such as Odoo POS modules) work without modification.

Supported printer families (ISL protocol):

- **Datecs** — FP-700, FP-700X, and variants (`bg.dt.p.isl`, `bg.dt.c.isl`, `bg.dt.x.isl`)
- **Eltrade** (`bg.ed.isl`)
- **Daisy** (`bg.dy.isl`)
- **Incotex** (`bg.in.isl`)
- **ICP** (`bg.is.icp`)
- **Tremol ZFP** (`bg.zk.zfp`, `bg.zk.v2.zfp`)

## New: Fiscal Memory Report

This port adds `POST /printers/:id/mreport` — an endpoint not present in the original server that prints a **fiscal memory report** directly from the printer's fiscal memory module.

```text
POST /printers/{printerId}/mreport
```

Request body (all fields optional):

```json
{
  "startDate": "2024-01-01",
  "endDate":   "2024-03-31",
  "detailed":  false
}
```

| Field       | Description                                                      |
| ----------- | ---------------------------------------------------------------- |
| `startDate` | Beginning of the date range (ISO date). Omit for full memory.    |
| `endDate`   | End of the date range (ISO date).                                |
| `detailed`  | `false` (default) — short report; `true` — full detailed report. |

The short report (`detailed: false`) prints a summary of daily Z-report totals for the requested period. The full report (`detailed: true`) prints every individual receipt record from fiscal memory. Both reports are printed directly on the fiscal printer's paper tape.

## New: Unique Sale Number (УНП) reservation

This port adds `POST /printers/:id/usn` — an endpoint not present in the
original server. It lets the print server act as the authoritative, **offline-safe**
source of Unique Sale Numbers (УНП) for a fiscal device, per Наредба № Н-18/2006,
Приложение №29 т.9.

```text
POST /printers/{printerId}/usn
```

Request body:

```json
{
  "operatorCode": "0001",
  "idempotencyKey": "00042-001-0007"
}
```

| Field            | Description                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `operatorCode`   | 4-char operator code embedded in the USN (Odoo `res.users.ref`).  |
| `idempotencyKey` | Stable per-sale key (Odoo POS order `uid`); retries reuse number. |

Response:

```json
{
  "uniqueSaleNumber": "DT970048-0001-0000001",
  "sequenceNumber": 1,
  "serialNumber": "DT970048",
  "reused": false
}
```

The device serial is resolved from the printer itself. The per-device counter is
**persisted durably** (write to temp → `fsync` → atomic rename → directory
`fsync`, plus a `.bak` snapshot) so a crash or power loss can never repeat or
lose a number, and allocation is **idempotent** by `idempotencyKey` so retries
and client reloads never burn or duplicate a number. Because it performs no
fiscal-device or network I/O, a client (such as an Odoo POS on an unreliable
internet link) can reserve a УНП over the LAN even while the internet is down.

### State location

The counter lives **outside the app directory** so a `git pull`, container
rebuild or `npm ci` cannot wipe it. Resolution order:

1. `UsnStatePath` in the `ErpNet.FP` section of `appsettings.json`
2. `USN_STATE_PATH` environment variable
3. `~/.erpnet-fp/usn-state.json` (default)

On systemd, prefer `StateDirectory=erpnet-fp` and point `USN_STATE_PATH` at
`/var/lib/erpnet-fp/usn-state.json`.

### Fail-closed safety & initialization

A duplicate УНП is a hard compliance violation, so the register **never invents a
starting number**:

- A device must be **explicitly initialized before it can mint** — with `0` for a
  brand-new device, or the recovered high-water mark after a state loss.
- A **missing** state file (deleted / reformatted / redeployed) leaves devices
  *uninitialized*; minting is refused (not silently restarted at 1).
- A **corrupt or wrong-shaped** state file makes the service refuse to start.

```text
GET  /printers/{printerId}/usn            → { serialNumber, initialized, counter, issuedKeys, statePath }
POST /printers/{printerId}/usn/init       → initialize / reseed the counter
```

`/usn/init` body: `{ "startSequence": <int>, "force": <bool>, "allowDecrease": <bool> }`.
It is **forward-only** (refuses to lower the counter unless `allowDecrease`) and,
when the `USN_ADMIN_TOKEN` env var is set, requires a matching
`X-USN-Admin-Token` header.

### Recovery after a state loss

The УНП recorded in Odoo (`pos.order.fiscal_usn`) is the audited system of record
and the recovery source of truth. Under the СУПТО retention model (Наредба № Н-18
Прил.29 т.12), **every issued УНП belongs to a retained order — completed or
cancelled/анулирана — and all are synced**, so once every terminal is drained
Odoo's `MAX` is the **exact** high-water mark. Н-18 forbids gaps, so recovery
reseeds to that exact value, no margin:

1. Stop selling on the affected device and **drain every terminal**: finish or
   cancel all open sales, then let the offline queues fully sync so every issued
   number (incl. cancelled sales) has reached Odoo.
2. Measure the per-device high-water mark:

   ```sql
   SELECT MAX(CAST(split_part(fiscal_usn, '-', 3) AS integer))
   FROM pos_order WHERE fiscal_usn LIKE 'DT970048-%';
   ```

3. Reseed forward: `POST /usn/init { startSequence: <max>, force: true }`.

The Odoo module `plana_pos_fiscal` automates steps 2–3 via the
**Initialize / Recover УНП** button on the POS config (run it from a browser on
the device's LAN). Only if a full drain is impossible should an operator add a
margin — accepting a documented gap in preference to a duplicate.

### Viewing УНП state in the admin page

The admin page (the service root, e.g. `http://<host>:8001/`) shows a read-only
**УНП state** panel under each detected printer — for validation without any
tooling. Click **Detect Printers**; each device then lists:

| Field | Meaning |
| --- | --- |
| Serial (ФУ ИН) | the device's individual number |
| Current sequence (high-water mark) | the counter — the last issued sequence |
| Next УНП | `SERIAL-…-<counter+1>` (the operator segment is filled per cashier at mint) |
| Remembered sale keys | how many recent idempotency keys are cached |
| State file | absolute path of the durable counter file |

A green **initialized** / red **NOT initialized** badge reflects the fail-closed
state, and a **Refresh УНП state** button re-reads it live. The panel is backed by
`GET /printers/:id/usn`, so it does no device or backend I/O and works offline.

## New: Invoice and credit note (invoice on the fiscal receipt)

The service can print a **fiscal invoice** (фактура) or **credit note** (кредитно
известие) directly on the fiscal receipt, so the fiscal document *is* the legal
invoice — no separate paper invoice needed.

```text
POST /printers/{printerId}/invoice      → print a fiscal invoice
POST /printers/{printerId}/creditnote   → print a fiscal credit note (storno)
```

Both use the same **async task** pattern as `/receipt` (`?asyncTimeout=0&taskId=…`,
then poll `taskinfo`), so retries are idempotent.

**Device capability — check before offering it.** Invoice printing is only
implemented by SIS-type devices. `GET /printers/{printerId}` reports the flags:

```json
{ "supportsInvoice": true, "supportsCreditNote": true,
  "invoiceNumberAssignment": "device-assigned",
  "creditNoteNumberAssignment": "device-assigned" }
```

On a device that doesn't support it the call returns error **`E413`** (not
supported) — so gate the feature on `supportsInvoice` / `supportsCreditNote`.

**Request body** — a normal receipt/reversal payload plus a `recipient`:

```json
POST /printers/{printerId}/invoice
{
  "uniqueSaleNumber": "DT970048-0001-0000042",
  "recipient": {
    "name": "ACME EOOD",
    "identifier": "203945123",
    "identifierType": "legal-registration",
    "address": "ul. Vitosha 1",
    "city": "Sofia",
    "vatNumber": "BG203945123"
  },
  "items":    [ { "text": "Product", "quantity": 1, "unitPrice": 10.0, "taxGroup": 2 } ],
  "payments": [ { "amount": 10.0, "paymentType": "card" } ]
}
```

- `identifierType` ∈ `unspecified` · `legal-registration` · `national-id` ·
  `foreigner-id` · `tax-number`. `name`, `identifier`, `identifierType` and
  `address` are required (missing ones → **`E405`**).
- **Number assignment:** when the flag is `device-assigned` (the default) the
  device sets the invoice/credit-note number — do **not** send `number`
  (sending one → **`E412`**). When it is `external-required`, send `number`.
- A **credit note** additionally requires `originalInvoiceNumber` and carries the
  reversal fields (`reason`, `receiptNumber`, `receiptDateTime`,
  `fiscalMemorySerialNumber`) that point back at the original document.

**In Odoo (`plana_pos_fiscal`):** enable *Invoice on fiscal receipt* on the POS
config to print the invoice on the device for to-invoice orders with a customer —
automatically skipped (falling back to a plain receipt) when the device lacks the
capability. The standard Odoo invoice flow remains available when the toggle is off.

## Running

```bash
npm install
node src/index.js
```

Configuration is in `appsettings.json`. The server listens on port `8001` by default and auto-detects connected fiscal printers on startup.

### On Raspberry Pi

```bash
# Add user to dialout group (once, requires re-login)
sudo usermod -aG dialout $USER

# Run
node src/index.js
```

For persistent operation, install as a systemd service:

```ini
[Unit]
Description=ErpNet.FP Fiscal Printer Service
After=network.target

[Service]
WorkingDirectory=/home/pi/ErpNet.FP.js
ExecStart=/usr/bin/node src/index.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now erpnet-fp
```

## License

Same as the original [ErpNet.FP](https://github.com/erpnet/ErpNet.FP) project.
