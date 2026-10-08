# @kestrel/rates

Rate card and zone data for the 2025 tariff.

- `RateCalculator` — base transport price (bands, volumetric weight, lane
  multipliers).
- `zones/` — postcode to zone class (A, B, R, X) using generated district
  tables. Regenerate with `node tools/gen-zones.mjs`.
- `registerRates()` — container registrations for this package.
