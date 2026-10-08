# @kestrel/pricing

Quote pricing engine. Takes a shipment request and produces a priced quote
with surcharges:

- `RateCalculator.calculate()` — base price from the weight table, then
  applies surcharges in order: fuel, remote area, residential.
- `surcharge.ts` — surcharge rules (remote area 3.5%, residential flat fee).
- `discounts.ts` — volume discount tiers.

Usage:

```ts
import { RateCalculator } from '@kestrel/pricing';
const calc = new RateCalculator();
const priced = calc.calculate({ weightKg: 2.5, toPostcode: 'HS1 2AB', service: 'standard' });
```
