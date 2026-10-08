# Changelog

## 4.12.0 (2025-09)
- tracking: stale shipment detection (`tracking.stale` event).
- gateway: per-tenant rate limiting on `/v2`.
- carriers: regenerated service codes (Wadden Vracht partner services).

## 4.11.0 (2025-07)
- billing: VAT zero-rating for GB exports.
- sdk: 2.3.0 with retry on 5xx.

## 4.10.0 (2025-05)
- rates: peak season window moved to config (`rates.peak`).
- notify: HMAC-signed webhooks behind `webhookSigning`.

## 4.8.0 (2025-03)
- rates: quote adjustments run as a configurable chain per pricing profile.
  Zone uplifts now come from the district tables and config basis points.
- gateway: `x-pricing-profile` override for internal tenants.

## 4.6.0 (2025-01)
- rates: generated postcode district tables (`tools/gen-zones.mjs`).
- shipping: quotes carry `pricingProfile`.

## 4.2.0 (2024-10)
- rates: zone engine v2 behind `zoneEngineV2` (off by default).

## 4.0.0 (2024-06)
- gateway: API v2 (`/v2/quotes`, `/v2/shipments`).
- gateway: tenants identified by API key.

## 3.4.2 (2024-02)
- pricing: remote area surcharge raised from 3% to 3.5%.

## 3.0.0 (2023-05)
- pricing: new pricing engine replacing the T2019 tariff for direct customers.
