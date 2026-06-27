'use strict';

const fs = require('fs');
const path = require('path');
const { ServiceController } = require('./Service/ServiceController');
const { Provider } = require('./Provider/Provider');
const { ComTransport } = require('./Transports/ComTransport');
const { TcpTransport } = require('./Transports/TcpTransport');
const { BgDatecsXIslFiscalPrinterDriver } = require('./Drivers/BgDatecs/BgDatecsXIslFiscalPrinter');
const { BgDatecsPIslFiscalPrinterDriver } = require('./Drivers/BgDatecs/BgDatecsPIslFiscalPrinter');
const { BgDatecsCIslFiscalPrinterDriver } = require('./Drivers/BgDatecs/BgDatecsCIslFiscalPrinter');
const { BgEltradeIslFiscalPrinterDriver } = require('./Drivers/BgEltrade/BgEltradeIslFiscalPrinter');
const { BgDaisyIslFiscalPrinterDriver } = require('./Drivers/BgDaisy/BgDaisyIslFiscalPrinter');
const { BgIncotexIslFiscalPrinterDriver } = require('./Drivers/BgIncotex/BgIncotexIslFiscalPrinter');
const { BgIslIcpFiscalPrinterDriver } = require('./Drivers/BgIsl/BgIslIcpFiscalPrinter');
const { BgTremolZfpFiscalPrinterDriver } = require('./Drivers/BgTremol/BgTremolZfpFiscalPrinter');
const { BgTremolZfpV2FiscalPrinterDriver } = require('./Drivers/BgTremol/BgTremolZfpV2FiscalPrinter');

const APP_SETTINGS_FILE = path.join(process.cwd(), 'appsettings.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(APP_SETTINGS_FILE, 'utf8');
    const json = JSON.parse(raw);
    return json['ErpNet.FP'] || {};
  } catch (e) {
    return {};
  }
}

function saveConfig(configOptions) {
  try {
    let json = {};
    try { json = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8')); } catch (_) {}
    json['ErpNet.FP'] = configOptions;
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(json, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e.message);
  }
}

class ServiceSingleton extends ServiceController {
  constructor() {
    const configData = loadConfig();
    const { ServiceOptions } = require('./Configuration/ServiceOptions');
    const opts = Object.assign(new ServiceOptions(), configData);
    super(opts);
  }

  setupProvider() {
    const comTransport = new ComTransport();
    const tcpTransport = new TcpTransport();

    const datecsXIsl  = new BgDatecsXIslFiscalPrinterDriver();
    const datecsPIsl  = new BgDatecsPIslFiscalPrinterDriver();
    const datecsCIsl  = new BgDatecsCIslFiscalPrinterDriver();
    const eltradeIsl  = new BgEltradeIslFiscalPrinterDriver();
    const daisyIsl    = new BgDaisyIslFiscalPrinterDriver();
    const incotexIsl  = new BgIncotexIslFiscalPrinterDriver();
    const islIcp      = new BgIslIcpFiscalPrinterDriver();
    const tremolZfp   = new BgTremolZfpFiscalPrinterDriver();
    const tremolV2Zfp = new BgTremolZfpV2FiscalPrinterDriver();

    this._provider = new Provider(this._configOptions)
      .register(datecsXIsl,  comTransport)
      .register(datecsXIsl,  tcpTransport)
      .register(datecsCIsl,  comTransport)
      .register(datecsCIsl,  tcpTransport)
      .register(datecsPIsl,  comTransport)
      .register(datecsPIsl,  tcpTransport)
      .register(eltradeIsl,  comTransport)
      .register(eltradeIsl,  tcpTransport)
      .register(daisyIsl,    comTransport)
      .register(daisyIsl,    tcpTransport)
      .register(incotexIsl,  comTransport)
      .register(incotexIsl,  tcpTransport)
      .register(islIcp,      comTransport)
      .register(islIcp,      tcpTransport)
      .register(tremolZfp,   comTransport)
      .register(tremolZfp,   tcpTransport)
      .register(tremolV2Zfp, comTransport)
      .register(tremolV2Zfp, tcpTransport);
  }

  _writeOptions() {
    saveConfig(this._configOptions);
  }
}

module.exports = { ServiceSingleton };
