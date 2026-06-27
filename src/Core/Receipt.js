'use strict';

const { Credentials } = require('./Credentials');

class Receipt extends Credentials {
  constructor() {
    super();
    this.UniqueSaleNumber = '';
    this.Items = [];
    this.Payments = [];
  }
}

module.exports = { Receipt };
