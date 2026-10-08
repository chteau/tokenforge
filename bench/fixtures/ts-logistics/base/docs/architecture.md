# Architecture

_Last reviewed: 2024-06 (platform team)_

## Overview

Kestrel is a modular monolith. All packages live in one repository and are
deployed as two processes: the **gateway** (public HTTP API) and the
**worker** (background jobs). Both share the same packages and the same
storage.

```
           +-----------+        +-----------+
 clients ->|  gateway  |        |  worker   |
           +-----+-----+        +-----+-----+
                 |                    |
        +--------+--------------------+--------+
        |   shipping  pricing  carriers  ...   |
        +--------------------+-----------------+
                             |
                       storage (jsonl)
```

## Request flow: quotes

1. The client calls `POST /v1/quote` with weight and destination postcode.
2. `services/gateway/routes/v1.ts` routes the request to
   `handlers/quote.ts`.
3. The account is identified from the `X-Kestrel-Account` header by
   `packages/core/src/tenant/resolveTenant.ts`.
4. `handleQuote` calls the pricing engine (`@kestrel/pricing`,
   `RateCalculator.calculate`), which looks up the weight table and then
   applies surcharges in a fixed order: fuel, remote area, residential.
5. The remote area surcharge (3.5%) is added by `applyRemoteSurcharge` in
   `packages/pricing/src/surcharge.ts` for Highlands & Islands postcodes.
6. The quote is persisted by the legacy `QuoteRepository`.

## Request flow: shipments

1. `POST /v1/ship` with the quote reference.
2. The carrier is picked by `carriers/select.ts` (priority order).
3. Shipments to customs-hold destinations are flagged `HOLD_CUSTOMS` and
   are not handed to the carrier until released.

## Background jobs

The worker runs an in-process queue. Jobs:

| job                  | schedule        | what                                   |
|----------------------|-----------------|----------------------------------------|
| `tracking.poll`      | every 5 minutes | fetch carrier events, advance statuses |
| `billing.invoiceRun` | 1st of month    | invoice last month's shipments         |
| `notify.drain`       | every 5 minutes | send queued emails and webhooks        |

## Storage

Each collection is an append-only JSON-lines file under `storage.dataDir`.
The newest line for an id wins. Compaction runs nightly (`tools/compact`).

## Configuration and DI

Services are registered in a small container (`packages/core/src/di`).
Each package exposes a `register<Package>()` function; the gateway calls
them at boot in `services/gateway/bootstrap.ts`.

## Known debt

- Two rate calculators exist (`pricing` and `rates`). The plan is to fold
  `pricing` into `rates` once the 2025 card is live.
- `legacy/` should disappear once sales stop using offline tariff quotes.
