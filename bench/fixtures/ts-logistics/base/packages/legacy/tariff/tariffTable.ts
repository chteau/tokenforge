/** Frozen T2019 tariff card, pence per kg band. */
export interface TariffRow {
  tariff: string;
  maxKg: number;
  pence: number;
}

export const TARIFFS: TariffRow[] = [
  { tariff: 'T2019', maxKg: 1, pence: 410 },
  { tariff: 'T2019', maxKg: 2, pence: 470 },
  { tariff: 'T2019', maxKg: 5, pence: 640 },
  { tariff: 'T2019', maxKg: 10, pence: 850 },
  { tariff: 'T2019', maxKg: 20, pence: 1270 },
  { tariff: 'T2019', maxKg: 30, pence: 1690 },
  { tariff: 'T2019-C', maxKg: 1, pence: 370 },
  { tariff: 'T2019-C', maxKg: 2, pence: 420 },
  { tariff: 'T2019-C', maxKg: 5, pence: 580 },
  { tariff: 'T2019-C', maxKg: 10, pence: 770 },
  { tariff: 'T2019-C', maxKg: 20, pence: 1150 },
  { tariff: 'T2019-C', maxKg: 30, pence: 1520 },
  { tariff: 'T2019-EU', maxKg: 1, pence: 690 },
  { tariff: 'T2019-EU', maxKg: 2, pence: 780 },
  { tariff: 'T2019-EU', maxKg: 5, pence: 1040 },
  { tariff: 'T2019-EU', maxKg: 10, pence: 1390 },
  { tariff: 'T2019-EU', maxKg: 20, pence: 2050 },
  { tariff: 'T2019-EU', maxKg: 30, pence: 2740 },
];

export function lookupTariff(tariff: string, kg: number): number {
  const row = TARIFFS.find((r) => r.tariff === tariff && kg <= r.maxKg);
  if (!row) throw new Error(`tariff ${tariff} has no band for ${kg}kg`);
  return row.pence;
}
