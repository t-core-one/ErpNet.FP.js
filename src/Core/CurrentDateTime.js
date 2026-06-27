'use strict';

const { Credentials } = require('./Credentials');

class CurrentDateTime extends Credentials {
  constructor() {
    super();
    this.DeviceDateTime = null;
  }
}

module.exports = { CurrentDateTime };
