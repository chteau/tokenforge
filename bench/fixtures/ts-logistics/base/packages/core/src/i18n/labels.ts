/** Customer-facing labels for line item codes. */
const LABELS: Record<string, Record<string, string>> = {
  en: {
    BAS: 'Parcel transport',
    BAP: 'Pallet transport',
    BAD: 'Document transport',
    FSC: 'Fuel index adjustment',
    ZNA: 'Zone A uplift',
    ZNB: 'Zone B uplift',
    RAS: 'Remote area surcharge',
    XAS: 'Extended area surcharge',
    RES: 'Residential delivery',
    PKS: 'Peak season surcharge',
    CCF: 'Customs clearance fee',
    DTY: 'Import duty (estimate)',
    INS: 'Declared value cover',
    DSC: 'Contract discount',
    VAT: 'VAT',
  },
  fr: {
    BAS: 'Transport colis',
    BAP: 'Transport palette',
    BAD: 'Transport documents',
    FSC: 'Ajustement carburant',
    ZNA: 'Majoration zone A',
    ZNB: 'Majoration zone B',
    RAS: 'Supplément zone éloignée',
    XAS: 'Supplément zone étendue',
    RES: 'Livraison résidentielle',
    PKS: 'Supplément haute saison',
    CCF: 'Frais de dédouanement',
    DTY: 'Droits de douane (estimation)',
    INS: 'Assurance valeur déclarée',
    DSC: 'Remise contrat',
    VAT: 'TVA',
  },
  nl: {
    BAS: 'Pakketvervoer',
    RAS: 'Toeslag afgelegen gebied',
    FSC: 'Brandstoftoeslag',
    RES: 'Bezorging particulier',
    VAT: 'btw',
  },
};

export function label(code: string, locale = 'en'): string {
  const lang = locale.slice(0, 2).toLowerCase();
  return LABELS[lang]?.[code] ?? LABELS.en[code] ?? code;
}

export function marketLocale(market: string): string {
  switch (market) {
    case 'FR':
    case 'BE':
      return 'fr';
    case 'NL':
      return 'nl';
    default:
      return 'en';
  }
}
