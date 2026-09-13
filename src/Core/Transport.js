/**
 * A transport owns channels for its kind of address (serial port, TCP endpoint,
 * HTTP URL). A CHANNEL is the device connection; what drivers actually receive
 * is a ChannelLease over one, so that a probe can be revoked without touching
 * the channel every other probe on that address is sharing.
 *
 * The channel contract, implemented by ComChannel, TcpChannel and HttpChannel:
 *   get descriptor()            stable identity — drivers key their caches on it
 *   write(data, signal)         refuses once `signal` is aborted
 *   read(signal)                one FIFO of readers; rejects once `signal` is aborted
 *   purgeInput()                drop buffered bytes that predate the next command
 *   close() / dispose()         release the OS resource; dispose() is permanent
 */
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

  /** A channel that is NOT in the cache — detection probes on this one. */
  createFreshChannel(address) {
    throw new Error('createFreshChannel must be implemented');
  }

  /** Publish a channel as the one for this address, after a successful detect. */
  cacheChannel(address, channel) {
    throw new Error('cacheChannel must be implemented');
  }

  drop(channel) {
    throw new Error('drop must be implemented');
  }
}
