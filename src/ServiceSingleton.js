import fs from 'fs';
import path from 'path';
import logger from './logger.js';
import { ServiceController } from './Service/ServiceController.js';
import { ServiceOptions } from './Configuration/ServiceOptions.js';
import { Provider } from './Provider/Provider.js';
import { ComTransport } from './Transports/ComTransport.js';
import { TcpTransport } from './Transports/TcpTransport.js';
import { BgDatecsXIslFiscalPrinterDriver } from './Drivers/BgDatecs/BgDatecsXIslFiscalPrinter.js';
import { BgDatecsPIslFiscalPrinterDriver } from './Drivers/BgDatecs/BgDatecsPIslFiscalPrinter.js';
import { BgDatecsCIslFiscalPrinterDriver } from './Drivers/BgDatecs/BgDatecsCIslFiscalPrinter.js';
import { BgEltradeIslFiscalPrinterDriver } from './Drivers/BgEltrade/BgEltradeIslFiscalPrinter.js';
import { BgDaisyIslFiscalPrinterDriver } from './Drivers/BgDaisy/BgDaisyIslFiscalPrinter.js';
import { BgIncotexIslFiscalPrinterDriver } from './Drivers/BgIncotex/BgIncotexIslFiscalPrinter.js';
import { BgIslIcpFiscalPrinterDriver } from './Drivers/BgIsl/BgIslIcpFiscalPrinter.js';
import { BgTremolZfpFiscalPrinterDriver } from './Drivers/BgTremol/BgTremolZfpFiscalPrinter.js';
import { BgTremolZfpV2FiscalPrinterDriver } from './Drivers/BgTremol/BgTremolZfpV2FiscalPrinter.js';

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
    logger.error(`Failed to save config: ${e.message}`);
  }
}

export class ServiceSingleton extends ServiceController {
  constructor() {
    const configData = loadConfig();
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
