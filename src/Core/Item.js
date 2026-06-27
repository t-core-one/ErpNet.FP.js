'use strict';

const ItemType = Object.freeze({
  Sale: 'sale',
  Comment: 'comment',
  FooterComment: 'footer-comment',
  SurchargeAmount: 'surcharge-amount',
  DiscountAmount: 'discount-amount',
});

const PriceModifierType = Object.freeze({
  None: 0,
  DiscountPercent: 1,
  DiscountAmount: 2,
  SurchargePercent: 3,
  SurchargeAmount: 4,
});

const TaxGroup = Object.freeze({
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

class Item {
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
    this.PriceModifierType = PriceModifierType.None;
  }
}

module.exports = { ItemType, PriceModifierType, TaxGroup, Item };
