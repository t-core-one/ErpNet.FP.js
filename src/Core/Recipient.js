export const RecipientIdentifierType = Object.freeze({
  Unspecified: 'unspecified',
  LegalRegistration: 'legal-registration',
  NationalId: 'national-id',
  ForeignerId: 'foreigner-id',
  TaxNumber: 'tax-number',
});

export class Recipient {
  constructor() {
    this.Name = '';
    this.Identifier = '';
    this.IdentifierType = RecipientIdentifierType.Unspecified;
    this.Address = '';
    this.City = '';
    this.VatNumber = '';
  }
}
