export class Transport {
  get transportName() {
    throw new Error('transportName must be implemented');
  }

  getAvailableAddresses() {
    throw new Error('getAvailableAddresses must be implemented');
  }

  openChannel(address) {
    throw new Error('openChannel must be implemented');
  }

  drop(channel) {
    throw new Error('drop must be implemented');
  }
}
