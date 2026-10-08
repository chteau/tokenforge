/*
 * Tariff surcharges (T2019).
 *
 * REMOTE AREA: 3.5% of the tariff price for Highlands & Islands postcodes.
 * OUT OF HOURS: flat 250p.
 */

export const REMOTE_POSTCODE_PREFIXES = ['HS', 'ZE', 'KW15', 'KW16', 'KW17', 'IV41', 'IV42', 'IV43', 'IV44', 'IV45', 'IV46', 'IV47', 'IV48', 'IV49', 'IV51', 'IV55', 'IV56', 'PA41', 'PA42', 'PA43', 'PA44', 'PA45', 'PA46', 'PA47', 'PA48', 'PA49', 'PA60', 'PA61', 'PA62', 'PA63', 'PA64', 'PA65', 'PA66', 'PA67', 'PA68', 'PA69', 'PA70', 'PA71', 'PA72', 'PA73', 'PA74', 'PA75', 'PA76', 'PA77', 'PA78', 'PH30', 'PH31', 'PH32', 'PH33', 'PH34', 'PH35', 'PH36', 'PH37', 'PH38', 'PH39', 'PH40', 'PH41', 'PH42', 'PH43', 'PH44', 'KA27', 'KA28', 'TR21', 'TR22', 'TR23', 'TR24', 'TR25'];

export const REMOTE_AREA_RATE = 0.035;
export const OUT_OF_HOURS_PENCE = 250;

export function remoteAreaSurcharge(tariffPence: number, postcode: string): number {
  const pc = postcode.toUpperCase().replace(/\s/g, '');
  const remote = REMOTE_POSTCODE_PREFIXES.some((p) => pc.startsWith(p));
  return remote ? Math.round(tariffPence * REMOTE_AREA_RATE) : 0;
}

export function outOfHoursSurcharge(outOfHours: boolean): number {
  return outOfHours ? OUT_OF_HOURS_PENCE : 0;
}
