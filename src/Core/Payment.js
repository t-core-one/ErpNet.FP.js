'use strict';

const PaymentType = Object.freeze({
  Unspecified: 0,
  Cash: 1,
  Check: 2,
  Coupons: 3,
  ExtCoupons: 4,
  Packaging: 5,
  InternalUsage: 6,
  Damage: 7,
  Card: 8,
  Bank: 9,
  Reserved1: 10,
  Reserved2: 11,
  Change: -1,
});

class Payment {
  constructor() {
    this.PaymentType = PaymentType.Cash;
    this.Amount = 0;
  }
}

module.exports = { PaymentType, Payment };
