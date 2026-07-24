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
  'printFiscalMemoryReport', 'getError',
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
    // Optional: e-mail each rendered receipt instead of a physical printout.
    // { to, from?, host?, port?, secure?, user?, pass?, subjectPrefix? }
    email: options.email || null,
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

  const money = (n) => Number(n || 0).toFixed(2);
  const mediumName = (m) => (Number(m) === 0 ? 'В брой / Cash' : `Плащане / Payment (medium ${m})`);

  /**
   * Render the received printReceipt params into a plain-text receipt — what a
   * real device would put on paper — for the e-mail body (or console).
   */
  function renderReceiptText(prms, meta) {
    const begin = prms.beginFiscalReceiptInput || {};
    const kind = meta.isStorno
      ? (meta.isInvoice ? 'КРЕДИТНО ИЗВЕСТИЕ / CREDIT NOTE' : 'СТОРНО / REVERSAL RECEIPT')
      : (meta.isInvoice ? 'ФАКТУРА / INVOICE' : 'ФИСКАЛЕН БОН / FISCAL RECEIPT');
    const L = [];
    const rule = '----------------------------------------';
    L.push('========================================');
    L.push(`  ${kind}`);
    L.push('========================================');
    L.push(`ФУ / Device:  ${state.fdNumber}    ФП / FM: ${state.fmNumber}`);
    L.push(`Бон № / No:   ${meta.receiptNumber}`);
    if (begin.usn) L.push(`УНП / USN:    ${begin.usn}`);
    const op = begin.operatorName || begin.operatorNumber;
    if (op != null) L.push(`Оператор:     ${op}`);
    L.push(`Дата / Date:  ${meta.date.toISOString().slice(0, 19).replace('T', ' ')}`);
    L.push(rule);
    for (const f of prms.freeprint || []) L.push(`  ${f.text || ''}`);
    for (const it of prms.receiptItems || []) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.price || 0);
      L.push(it.description || '');
      L.push(`    ${qty} x ${money(price)} = ${money(round2(qty * price))}   [ДДС гр. ${it.enumVatCategory}]`);
      for (const tl of it.textlines || []) L.push(`      ${tl.text || ''}`);
    }
    for (const s of prms.subtotal || []) {
      L.push(`  ${s.subtotalText || 'Отстъпка/Надбавка'}: ${money(s.subtotalSurchargeAmount)}`);
    }
    L.push(rule);
    for (const p of prms.receiptPayments || []) {
      L.push(`${mediumName(p.medium)}:  ${money(p.amount)}`);
      if (p.change) L.push(`Ресто / Change:  ${money(p.change)}`);
    }
    L.push(`ОБЩО / TOTAL:  ${money(meta.total)}`);
    L.push(rule);
    if (prms.invoiceData) {
      const inv = prms.invoiceData;
      L.push('Получател / Recipient:');
      L.push(`  Фактура № / Invoice No: ${inv.invNumber || ''}`);
      if (inv.recipientName) L.push(`  ${inv.recipientName}`);
      if (inv.identNumber) L.push(`  ЕИК/ID: ${inv.identNumber}`);
      if (inv.vatIdentNumber) L.push(`  ДДС № / VAT: ${inv.vatIdentNumber}`);
      L.push(`  ${[inv.recipientAddress, inv.city].filter(Boolean).join(', ')}`);
      L.push(rule);
    }
    if (prms.stornoInput) {
      const st = prms.stornoInput;
      L.push('Сторниран документ / Reversal of:');
      L.push(`  Бон № / Receipt: ${st.receiptNumber || ''}    ФП / FM: ${st.fiscMemNumber || ''}`);
      L.push(rule);
    }
    for (const f of prms.textAfterPayment || []) L.push(`  ${f.text || ''}`);
    L.push(`QR: ${meta.qr}`);
    L.push('========================================');
    return L.join('\n');
  }

  let _transport = null;
  /** E-mail the rendered receipt text (fire-and-forget; failures only log). */
  async function sendReceiptEmail(subject, text) {
    const e = state.email;
    if (!e || !e.to) return;
    try {
      if (!_transport) {
        const nodemailer = await import('nodemailer');
        _transport = nodemailer.createTransport({
          host: e.host || 'localhost',
          port: e.port || 587,
          secure: !!e.secure,
          auth: e.user ? { user: e.user, pass: e.pass } : undefined,
        });
      }
      await _transport.sendMail({
        from: e.from || e.user || 'sis-emu@localhost',
        to: e.to,
        subject: `${e.subjectPrefix || '[sis-emu]'} ${subject}`,
        text,
      });
      log(`emailed receipt to ${e.to}: ${subject}`);
    } catch (err) {
      log(`WARN e-mail failed (${err && err.message}); receipt text follows:\n${text}`);
    }
  }

  /** "Print" a document: e-mail it when configured, else echo to the console. */
  function emitDoc(subject, text) {
    if (state.email && state.email.to) sendReceiptEmail(subject, text);
    else log(`document (no e-mail configured):\n${text}`);
  }

  const RULE = '----------------------------------------';
  const isoTs = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

  /** Render a cash in/out slip (deposit = positive amount, withdraw = negative). */
  function renderCashText(amount, balance, date, reason) {
    const isIn = amount >= 0;
    const L = [
      '========================================',
      `  ${isIn ? 'ВНАСЯНЕ / CASH IN' : 'ИЗНАСЯНЕ / CASH OUT'}`,
      '========================================',
      `ФУ / Device:  ${state.fdNumber}    ФП / FM: ${state.fmNumber}`,
      RULE,
      `Сума / Amount:         ${money(Math.abs(amount))}`,
    ];
    if (reason) L.push(`Основание / Reason:    ${reason}`);
    L.push(`Каса след / Balance:   ${money(balance)}`);
    L.push(`Дата / Date:   ${isoTs(date)}`);
    L.push('========================================');
    return L.join('\n');
  }

  /** Render a Z/X report or duplicate. The emulator has no daily totals, so this
   *  is a summary of its state — a real device prints the full fiscal figures. */
  function renderReportText(kind, date, detailed) {
    const lines = [
      '========================================',
      `  ${kind}`,
      '========================================',
      `ФУ / Device:  ${state.fdNumber}    ФП / FM: ${state.fmNumber}`,
      RULE,
    ];
    // Only the fiscal-memory report carries a short/detailed distinction
    // (detailed is undefined for Z/X/duplicate).
    if (detailed !== undefined) {
      lines.push(
        `Тип / Type:    ${detailed ? 'ПОДРОБЕН (по данъчни групи) / DETAILED' : 'КРАТЪК / SHORT'}`
      );
    }
    lines.push(
      `Бонове / Receipts so far:  ${state.receiptCounter}`,
      `Каса / Cash in drawer:     ${money(state.cashBalance)}`,
      `Дата / Date:   ${isoTs(date)}`,
      '(Емулатор — реалното устройство отпечатва пълните дневни суми.)',
      '========================================',
    );
    return lines.join('\n');
  }

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
      case 'getError':
        return baseOk(id);

      case 'printZReport':
      case 'printXReport':
      case 'printDuplicate':
      case 'printFiscalMemoryReport': {
        const kinds = {
          printZReport: 'Z-ОТЧЕТ / Z REPORT',
          printXReport: 'X-ОТЧЕТ / X REPORT',
          printDuplicate: 'ДУБЛИКАТ / DUPLICATE',
          printFiscalMemoryReport: 'ОТЧЕТ ФИСКАЛНА ПАМЕТ / FISCAL MEMORY REPORT',
        };
        let kind = kinds[method];
        const isMemory = method === 'printFiscalMemoryReport';
        const detailed = isMemory && params ? !!params.detailed : false;
        if (isMemory && params && (params.startDate || params.endDate)) {
          kind += ` (${params.startDate || '…'} — ${params.endDate || '…'})`;
        }
        if (detailed) {
          kind += ' — ПОДРОБЕН / DETAILED';
        }
        log(method + (detailed ? ' (detailed)' : ''));
        emitDoc(kind, renderReportText(kind, new Date(), isMemory ? detailed : undefined));
        return baseOk(id);
      }

      case 'getCashBalance':
        return { ...baseOk(id), cashBalance: state.cashBalance.toFixed(2) };

      case 'cashHandling': {
        // amount is negative for a withdraw (the driver already negates it).
        const amount = Number((params && params.amount) || 0);
        state.cashBalance = round2(state.cashBalance + amount);
        log(`cashHandling ${amount >= 0 ? 'IN' : 'OUT'} ${money(Math.abs(amount))} balance=${money(state.cashBalance)}`);
        emitDoc(
          `${amount >= 0 ? 'Внасяне' : 'Изнасяне'} ${money(Math.abs(amount))}`,
          renderCashText(amount, state.cashBalance, new Date(), params && params.reason)
        );
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

        // "Print" the receipt as text: e-mail it when SMTP is configured,
        // otherwise echo it to the console.
        const receiptText = renderReceiptText(prms, {
          isStorno, isInvoice, total, receiptNumber: state.receiptCounter, qr, date: d,
        });
        const subject = `${isStorno ? 'Сторно' : isInvoice ? 'Фактура' : 'Фискален бон'} #${state.receiptCounter}${usn ? ' · УНП ' + usn : ''}`;
        emitDoc(subject, receiptText); // fire-and-forget e-mail (or console); never blocks the response

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
    // Set SIS_EMU_EMAIL_TO to e-mail every rendered receipt (requires nodemailer
    // and an SMTP server); otherwise the receipt text is printed to the console.
    email: process.env.SIS_EMU_EMAIL_TO
      ? {
          to: process.env.SIS_EMU_EMAIL_TO,
          from: process.env.SIS_EMU_EMAIL_FROM,
          host: process.env.SIS_EMU_SMTP_HOST,
          port: process.env.SIS_EMU_SMTP_PORT ? Number(process.env.SIS_EMU_SMTP_PORT) : undefined,
          secure: process.env.SIS_EMU_SMTP_SECURE === 'true',
          user: process.env.SIS_EMU_SMTP_USER,
          pass: process.env.SIS_EMU_SMTP_PASS,
        }
      : null,
  });
  emu.listen(port).then((p) => {
    console.log(`[sis-emu] SIS fiscal-device emulator listening on http://localhost:${p}`);
    console.log(`[sis-emu] Configure ErpNet.FP.js printer URI: bg.sis.json://localhost:${p}`);
    console.log(`[sis-emu] FDNumber=${emu.state.fdNumber} FMNumber=${emu.state.fmNumber} model=${emu.state.model}`);
    console.log(
      emu.state.email && emu.state.email.to
        ? `[sis-emu] Receipts e-mailed to ${emu.state.email.to} via ${emu.state.email.host || 'localhost'}:${emu.state.email.port || 587}`
        : '[sis-emu] Receipts printed to console (set SIS_EMU_EMAIL_TO + SIS_EMU_SMTP_* to e-mail them)'
    );
    console.log('[sis-emu] Control: GET /__state · POST /__fault {"prn":"PAPER END"} · POST /__fault {"clear":true}');
  });
}
