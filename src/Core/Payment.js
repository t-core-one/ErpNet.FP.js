export const PaymentType = Object.freeze({
  Cash: 'cash',
  Check: 'check',
  Coupons: 'coupons',
  ExtCoupons: 'ext-coupons',
  Packaging: 'packaging',
  InternalUsage: 'internal-usage',
  Damage: 'damage',
  Card: 'card',
  Bank: 'bank',
  Reserved1: 'reserved1',
  Reserved2: 'reserved2',
  Change: 'change',
});

export class Payment {
  constructor() {
    this.PaymentType = PaymentType.Cash;
    this.Amount = 0;
  }
}
