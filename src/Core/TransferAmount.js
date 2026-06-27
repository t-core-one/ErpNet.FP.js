'use strict';

const { Credentials } = require('./Credentials');

class TransferAmount extends Credentials {
  constructor() {
    super();
    this.Amount = 0;
  }
}

module.exports = { TransferAmount };
