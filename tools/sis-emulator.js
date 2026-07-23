/**
 * SIS fiscal-device emulator.
 *
 * A dependency-free HTTP server that speaks the SIS JSON-RPC protocol that the
 * `bg.sis.json` driver (BgSisJsonFiscalPrinter) talks over HttpTransport. Point
 * ErpNet.FP.js at it with a printer URI `bg.sis.json://<host>:<port>` and the
 * whole stack — Odoo → ErpNet.FP.js → driver → this emulator — runs end-to-end
 * with no hardware.
 *
 * It maintains real-ish state (a fiscal-receipt counter, cash drawer, last QR
 * code) and returns proper QR payloads so receipt numbers/amounts flow back to
 * Odoo. A tiny control surface lets a test inject faults (paper end, …) to
 * exercise the "device can't issue a receipt → payment blocked" path.
 *
 * Run standalone:   node tools/sis-emulator.js            (PORT env, default 8199)
 * Import in a test: import { createSisEmulator } from './tools/sis-emulator.js'
 */

import http from 'http';
import { fileURLToPath } from 'url';

const KNOWN_METHODS = new Set([
  'getMfcInfo', 'getStatus', 'setTime', 'getCashBalance', 'cashHandling',
  'printReceipt', 'getData', 'printZReport', 'printXReport', 'printDuplicate',
  'getError',
]);

const p2 = (n) => String(n).padStart(2, '0');
const pad10 = (n) => String(n).padStart(10, '0');
const round2 = (n) => Math.round(n * 100) / 100;

export function createSisEmulator(options = {}) {
  const state = {
    fdNumber: options.fdNumber || 'DT970048',      // FU serial (2 letters + 6 digits)
    fmNumber: options.fmNumber || '50170034',       // fiscal memory serial
    idNumber: options.idNumber || 'BG204999888',     // tax id
    model: options.model || 'MF-P1200DN',
    fw: options.fw || 'SIS-1.00BG-2024',
    receiptCounter: options.startReceipt || 0,
    cashBalance: options.startCash != null ? options.startCash : 0,
    lastQr: '',
    fault: null,                                     // e.g. { prn: 'PAPER END' }
    log: options.log !== false,
  };

  const log = (...a) => { if (state.log) console.log('[sis-emu]', ...a); };

  const statusTs = (d) =>
    `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const receiptTs = (d) =>
    `${p2(d.getSeconds())},${p2(d.getMinutes())},${p2(d.getHours())};${p2(d.getDate())},${p2(d.getMonth() + 1)},${String(d.getFullYear()).slice(-2)}`;
  const qrDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const qrTime = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

  const baseOk = (id) => ({ jsonrpc: '2.0', id, mfc_error: '0', mfc_error_message: 'EM_NO_ERROR' });

  const withFault = (resp) => {
    if (state.fault && state.fault.prn) resp.prn_status = [{ status: state.fault.prn }];
    if (state.fault && state.fault.mfc) {
      resp.mfc_error = state.fault.mfc.code;
      resp.mfc_error_message = state.fault.mfc.message;
    }
    return resp;
  };

  const paymentsTotal = (payments) => {
    let t = 0;
    for (const p of payments || []) t += Number(p.amount || 0) - Number(p.change || 0);
    return round2(t);
  };

  function handle(req) {
    const { id, method, params } = req;
    switch (method) {
      case 'getMfcInfo':
        return { jsonrpc: '2.0', id, FDNumber: state.fdNumber, FMNumber: state.fmNumber, IDNumber: state.idNumber };

      case 'getStatus':
        return withFault({
          ...baseOk(id),
          printerModel: state.model,
          fwChecksum: state.fw,
          timestamp: statusTs(new Date()),
          prn_status: [],
          mfc_status: [],
        });

      case 'setTime':
      case 'printZReport':
      case 'printXReport':
      case 'printDuplicate':
      case 'getError':
        return baseOk(id);

      case 'getCashBalance':
        return { ...baseOk(id), cashBalance: state.cashBalance.toFixed(2) };

      case 'cashHandling': {
        // amount is negative for a withdraw (the driver already negates it).
        const amount = Number((params && params.amount) || 0);
        state.cashBalance = round2(state.cashBalance + amount);
        return baseOk(id);
      }

      case 'printReceipt': {
        // A device fault means it cannot issue a receipt — surface the status
        // and do NOT advance the counter (no phantom fiscal receipt).
        if (state.fault) return withFault(baseOk(id));

        const prms = params || {};
        const isStorno = !!prms.stornoInput;
        const isInvoice = !!prms.invoiceData;
        const total = paymentsTotal(prms.receiptPayments);

        // Cash medium (0) moves the drawer; a storno refunds it.
        let cashDelta = 0;
        for (const pm of prms.receiptPayments || []) {
          if (Number(pm.medium) === 0) cashDelta += Number(pm.amount || 0) - Number(pm.change || 0);
        }
        state.cashBalance = round2(state.cashBalance + (isStorno ? -cashDelta : cashDelta));

        state.receiptCounter += 1;
        const d = new Date();
        const qr = `${state.fmNumber}*${pad10(state.receiptCounter)}*${qrDate(d)}*${qrTime(d)}*${total.toFixed(2)}`;
        state.lastQr = qr;

        const usn = prms.beginFiscalReceiptInput && prms.beginFiscalReceiptInput.usn;
        log(`printReceipt #${state.receiptCounter} ${isStorno ? 'STORNO ' : ''}${isInvoice ? 'INVOICE ' : ''}usn=${usn} total=${total.toFixed(2)}`);

        return {
          ...baseOk(id),
          qrcode: qr,
          grandReceiptNum: String(state.receiptCounter),
          receiptTimestamp: receiptTs(d),
        };
      }

      case 'getData':
        // Used as the LastQRCode fallback for receipt-info enrichment.
        return { ...baseOk(id), response: { data: state.lastQr } };

      default:
        log(`WARN unhandled method: ${method}`);
        return baseOk(id);
    }
  }

  const server = http.createServer((httpReq, httpRes) => {
    const url = httpReq.url || '/';

    // ── Control surface (not part of the SIS protocol) ──────────────────
    if (url.startsWith('/__state')) {
      httpRes.writeHead(200, { 'Content-Type': 'application/json' });
      httpRes.end(JSON.stringify({
        fdNumber: state.fdNumber, fmNumber: state.fmNumber,
        receiptCounter: state.receiptCounter, cashBalance: state.cashBalance,
        lastQr: state.lastQr, fault: state.fault,
      }));
      return;
    }
    if (url.startsWith('/__fault')) {
      let body = '';
      httpReq.on('data', (c) => (body += c));
      httpReq.on('end', () => {
        try {
          const f = JSON.parse(body || '{}');
          state.fault = f.clear ? null : f;
          log(`fault set to ${JSON.stringify(state.fault)}`);
          httpRes.writeHead(200, { 'Content-Type': 'application/json' });
          httpRes.end(JSON.stringify({ fault: state.fault }));
        } catch (e) {
          httpRes.writeHead(400, { 'Content-Type': 'application/json' });
          httpRes.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // ── SIS JSON-RPC (the driver POSTs here) ────────────────────────────
    let body = '';
    httpReq.on('data', (c) => (body += c));
    httpReq.on('end', () => {
      let reqJson;
      try {
        reqJson = JSON.parse(body || '{}');
      } catch (e) {
        httpRes.writeHead(400, { 'Content-Type': 'application/json' });
        httpRes.end(JSON.stringify({ error: { code: 'E401', message: 'invalid JSON' } }));
        return;
      }
      if (state.log && reqJson.method !== 'printReceipt') log(`→ ${reqJson.method}`);
      const resp = handle(reqJson);
      httpRes.writeHead(200, { 'Content-Type': 'application/json' });
      httpRes.end(JSON.stringify(resp));
    });
  });

  return {
    server,
    state,
    /** Start listening; resolves with the bound port (pass 0 for an ephemeral port). */
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = parseInt(process.env.PORT || '8199', 10);
  const emu = createSisEmulator({
    fdNumber: process.env.SIS_EMU_FD,
    fmNumber: process.env.SIS_EMU_FM,
    model: process.env.SIS_EMU_MODEL,
    startCash: process.env.SIS_EMU_CASH ? Number(process.env.SIS_EMU_CASH) : 0,
  });
  emu.listen(port).then((p) => {
    console.log(`[sis-emu] SIS fiscal-device emulator listening on http://localhost:${p}`);
    console.log(`[sis-emu] Configure ErpNet.FP.js printer URI: bg.sis.json://localhost:${p}`);
    console.log(`[sis-emu] FDNumber=${emu.state.fdNumber} FMNumber=${emu.state.fmNumber} model=${emu.state.model}`);
    console.log('[sis-emu] Control: GET /__state · POST /__fault {"prn":"PAPER END"} · POST /__fault {"clear":true}');
  });
}
