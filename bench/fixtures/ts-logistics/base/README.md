# Kestrel Freight

Shipment quoting, booking and tracking for B2B shippers in the UK, France
and the Netherlands.

## Layout

```
packages/
  core/       config, DI container, HTTP primitives, storage, money, codes
  rates/      rate card, zone tables, quote adjustments
  pricing/    pricing engine (see docs/pricing.md)
  carriers/   carrier adapters, carrier selection, service code table
  shipping/   quotes and shipments
  tracking/   carrier event ingestion
  billing/    monthly invoicing, VAT
  notify/     email / webhook fan-out
  legacy/     2019 monolith code still used by the sales CLI
  sdk/        public API client (generated)
services/
  gateway/    public HTTP API
  worker/     background jobs (tracking polls, invoicing, requotes)
tools/        CLI and code generators
config/       default.json + per-environment overrides, tenants
docs/         architecture notes, ADRs, runbooks
```

## Running

Requires Node 26 (native TypeScript type stripping). There are no npm
dependencies.

```sh
npm start            # gateway on :8080 (KESTREL_ENV=development)
npm run worker       # background worker
npm run cli -- zone GB "HS1 2AB"
npm test             # node --test
npm run typecheck    # tsc --noEmit
```

Configuration is layered: `config/default.json`, then
`config/<KESTREL_ENV>.json`, then `KESTREL__SECTION__KEY=value` environment
variables (e.g. `KESTREL__RATES__FUEL_INDEX_BPS=1200`).

## API

See `packages/sdk/api.json` for the public contract. Example:

```sh
curl -s localhost:8080/v2/quotes \
  -H 'x-api-key: kf_live_acme_7f3e' -H 'content-type: application/json' \
  -d '{"origin":{"country":"GB","postcode":"B1 1AA"},
       "destination":{"country":"GB","postcode":"PA42 7EA"},
       "parcels":[{"weightGrams":2500}],"service":"standard"}'
```

More detail in [docs/architecture.md](docs/architecture.md).
