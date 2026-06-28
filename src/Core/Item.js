export const ItemType = Object.freeze({
  Sale: 'sale',
  Comment: 'comment',
  FooterComment: 'footer-comment',
  SurchargeAmount: 'surcharge-amount',
  DiscountAmount: 'discount-amount',
});

export const PriceModifierType = Object.freeze({
  DiscountPercent: 'discount-percent',
  DiscountAmount: 'discount-amount',
  SurchargePercent: 'surcharge-percent',
  SurchargeAmount: 'surcharge-amount',
});

export const TaxGroup = Object.freeze({
  Unspecified: 0,
  TaxGroup1: 1,
  TaxGroup2: 2,
  TaxGroup3: 3,
  TaxGroup4: 4,
  TaxGroup5: 5,
  TaxGroup6: 6,
  TaxGroup7: 7,
  TaxGroup8: 8,
});

export class Item {
  constructor() {
    this.ItemCode = null;
    this.Type = ItemType.Sale;
    this.Text = '';
    this.TaxGroup = TaxGroup.TaxGroup1;
    this.Department = 0;
    this.Quantity = 0;
    this.UnitPrice = 0;
    this.Amount = 0;
    this.PriceModifierValue = 0;
    this.PriceModifierType = null;
  }
}
