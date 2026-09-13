import logger from '../logger.js';
import { parseTimeout } from '../Helpers/Helpers.js';
import { ChannelLease } from '../Core/ChannelLease.js';

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
    //
    // Sharing it is only safe because each probe gets its own REVOCABLE LEASE on
    // that channel rather than the channel itself. A probe abandoned by the race
    // below used to go on writing and reading for the rest of its retry budget —
    // ~15s for an ISL driver, far longer for ICP — on the very channel the next
    // driver was using, and the shared receive buffer handed it the next
    // driver's answer. That is why an FP-800, third in the driver list, reported
    // "Printers found: 0" while answering the port perfectly, and why the
    // stragglers were still writing to the channel a newly detected printer was
    // about to use for live fiscal traffic. Revoking ends the abandoned exchange
    // at its next write() or read(), and immediately if it is parked in a read.
    //
    // Note what this is NOT: a lock. No driver ever waits for the one before it.
    // Making the channel mutually exclusive was tried once — the abandoned probe
    // held the mutex, every later driver timed out waiting for it and NOTHING was
    // detected, six minutes of a shop with no fiscal printer. The newcomer here
    // revokes the straggler instead of queueing behind it.
    const driverTimeout = Math.min(timeoutMs, 5000);
    const channel = transport.createFreshChannel(address);
    let detected = false;
    try {
      for (const driver of drivers) {
        logger.debug(`Trying ${driver.driverName} @ ${address} ...`);
        const lease = new ChannelLease(channel, `${driver.driverName} @ ${address}`);
        let keepLease = false;
        try {
          const printer = await this._probeDriver(driver, lease, driverTimeout);
          if (printer && printer.info) {
            const uri = `${driver.driverName}://${address}`;
            printer.info.Uri = uri;
            printers[uri] = printer;
            transport.cacheChannel(address, channel);
            detected = true;
            // The printer keeps this lease as its channel for runtime traffic,
            // so it must survive. Every OTHER lease on this channel has already
            // been revoked by the time we get here, which is the point: nothing
            // is left running on the port a live printer just claimed.
            keepLease = true;
            logger.info(`Detected printer: ${uri} (${printer.info.Manufacturer} ${printer.info.Model} SN:${printer.info.SerialNumber})`);
            return;
          }
        } catch (e) {
          logger.debug(`${driver.driverName} @ ${address}: ${e.message}`);
        } finally {
          // Revoke here, not after the loop: the straggler has to be dead BEFORE
          // the next driver writes its first frame.
          if (!keepLease) lease.revoke('detection moved on to the next driver');
        }
      }
    } finally {
      if (!detected) {
        try { await transport.drop(channel); } catch (_) {}
      }
    }
  }

  /**
   * Give a driver driverTimeout to answer, then abandon it.
   *
   * The timeout is unchanged — detection must still move on quickly, and it must
   * not wait out an unresponsive driver's full retry budget. What changed is
   * what "abandon" means: the caller revokes the lease, so the probe stops
   * instead of running on invisibly.
   */
  async _probeDriver(driver, lease, driverTimeout) {
    const connectPromise = driver.connect(lease, this._serviceOptions, true, null);
    // An abandoned probe rejects with nobody listening, and an unhandled
    // rejection ends the process under Node's default policy. Log the ones that
    // died of revocation: a straggler used to vanish without trace, which is
    // part of why this cost so long to find.
    connectPromise.catch((e) => {
      if (lease.revoked) {
        logger.debug(`${driver.driverName} @ ${lease.descriptor}: abandoned probe ended (${e.message})`);
      }
    });
    let timer = null;
    try {
      return await Promise.race([
        connectPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Detection timeout')), driverTimeout);
        }),
      ]);
    } finally {
      // The loser's timer used to be left pending — one per driver, per address.
      if (timer) clearTimeout(timer);
    }
  }

  async connect(deviceUri) {
    const match = deviceUri.match(/^([^:]+):\/\/(.+)$/);
    if (!match) throw new Error(`Invalid device URI: ${deviceUri}`);
    const [, protocol, address] = match;

    for (const [, { driver, transport }] of this._drivers) {
      if (driver.driverName === protocol) {
        const channel = transport.openChannel(address);
        // A lease here too, never revoked. Uniformity is the point: a printer
        // only ever holds a lease, so purge-before-write and the single-reader
        // queue apply to configured devices exactly as they do to detected ones.
        const lease = new ChannelLease(channel, deviceUri);
        const printer = await driver.connect(lease, this._serviceOptions, false, null);
        if (printer && printer.info) {
          printer.info.Uri = deviceUri;
        }
        return printer;
      }
    }
    throw new Error(`No driver found for protocol: ${protocol}`);
  }
}
