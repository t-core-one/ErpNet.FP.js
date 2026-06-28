import logger from '../logger.js';
import { parseTimeout } from '../Helpers/Helpers.js';

export class Provider {
  constructor(serviceOptions) {
    this._serviceOptions = serviceOptions;
    this._drivers = new Map();
  }

  register(driver, transport) {
    const key = `${driver.driverName}.${transport.transportName}`;
    if (!this._drivers.has(key)) {
      this._drivers.set(key, { driver, transport });
    }
    return this;
  }

  async detectAvailablePrinters(excludedPorts = []) {
    const printers = {};
    const detectionTimeoutMs = parseTimeout(
      (this._serviceOptions && this._serviceOptions.DetectionTimeout) || '30s'
    );

    const addressMap = new Map();
    for (const [, { driver, transport }] of this._drivers) {
      const addresses = await transport.getAvailableAddresses();
      for (const address of addresses) {
        if (excludedPorts.includes(address)) continue;
        const addrKey = `${transport.transportName}:${address}`;
        if (!addressMap.has(addrKey)) {
          addressMap.set(addrKey, { transport, address, drivers: [] });
        }
        addressMap.get(addrKey).drivers.push(driver);
      }
    }

    const tasks = [];
    for (const { transport, address, drivers } of addressMap.values()) {
      tasks.push(this._detectPrinterAsync(transport, address, drivers, detectionTimeoutMs, printers));
    }
    await Promise.allSettled(tasks);
    return printers;
  }

  async _detectPrinterAsync(transport, address, drivers, timeoutMs, printers) {
    // Open one channel per address and share it across all driver attempts.
    // Closing and reopening between each driver causes OS port-lock contention on Linux.
    const driverTimeout = Math.min(timeoutMs, 5000);
    const channel = transport.createFreshChannel(address);
    let detected = false;
    try {
      for (const driver of drivers) {
        logger.debug(`Trying ${driver.driverName} @ ${address} ...`);
        try {
          const connectPromise = driver.connect(channel, this._serviceOptions, true, null);
          connectPromise.catch(() => {});
          const printer = await Promise.race([
            connectPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Detection timeout')), driverTimeout)),
          ]);
          if (printer && printer.info) {
            const uri = `${driver.driverName}://${address}`;
            printer.info.Uri = uri;
            printers[uri] = printer;
            transport.cacheChannel(address, channel);
            detected = true;
            logger.info(`Detected printer: ${uri} (${printer.info.Manufacturer} ${printer.info.Model} SN:${printer.info.SerialNumber})`);
            return;
          }
        } catch (e) {
          logger.debug(`${driver.driverName} @ ${address}: ${e.message}`);
        }
      }
    } finally {
      if (!detected) {
        try { await transport.drop(channel); } catch (_) {}
      }
    }
  }

  async connect(deviceUri) {
    const match = deviceUri.match(/^([^:]+):\/\/(.+)$/);
    if (!match) throw new Error(`Invalid device URI: ${deviceUri}`);
    const [, protocol, address] = match;

    for (const [, { driver, transport }] of this._drivers) {
      if (driver.driverName === protocol) {
        const channel = transport.openChannel(address);
        const printer = await driver.connect(channel, this._serviceOptions, false, null);
        if (printer && printer.info) {
          printer.info.Uri = deviceUri;
        }
        return printer;
      }
    }
    throw new Error(`No driver found for protocol: ${protocol}`);
  }
}
