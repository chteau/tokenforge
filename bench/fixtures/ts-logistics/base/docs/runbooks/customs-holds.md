# Runbook: customs holds

Shipments are flagged `HOLD_CUSTOMS` at booking when the destination is in
`customs.holdDestinations` or the declared value exceeds the low-value
threshold on an export. Held shipments are booked with the carrier but the
label is not released to the customer.

## Releasing a hold

- Customer uploads documents in the portal, or
- support calls `POST /v2/shipments/:id/release-hold` with the internal key.

## Common issues

- **Jersey/Guernsey parcels not held**: these are addressed with GB
  postcodes (`JE`, `GY`) and country `GB`; the hold list matches on country
  only.
- **Hold flag reappears**: the flag is only computed at booking. Check that
  the shipment was not re-booked from a requoted quote.
