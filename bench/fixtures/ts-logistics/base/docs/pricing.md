# Pricing

How a quote total is built.

## Base price

The base price comes from the weight table in the pricing engine
(`packages/pricing/src/RateCalculator.ts`). Weight is the actual weight in
kg; volumetric weight is not used for parcels under 30 kg.

## Surcharges

| code | name                  | rule                                         |
|------|-----------------------|----------------------------------------------|
| FSC  | Fuel surcharge        | 9.5% of transport                            |
| RAS  | Remote area surcharge | 3.5% of transport + fuel, remote postcodes   |
| RES  | Residential delivery  | flat 120p                                    |
| DSC  | Volume discount       | 4 / 8 / 12% by monthly volume                |

Remote postcodes are listed in `REMOTE_AREAS`
(`packages/pricing/src/surcharge.ts`): HS, ZE, KW, IV, PA, PH and the
Isles of Scilly (TR21–TR25).

> **Note (2025-02):** fuel is now indexed monthly; see the operations
> calendar for the current value.

## Contract customers

Contract customers are priced on their frozen tariff (`legacy/tariff`). The
remote area rule there is the same 3.5%, applied to the tariff price.

## Changing a surcharge

1. Edit the constant in `surcharge.ts`.
2. Update the unit tests in `packages/pricing/test`.
3. Announce the change to sales at least 30 days in advance.
