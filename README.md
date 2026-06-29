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
