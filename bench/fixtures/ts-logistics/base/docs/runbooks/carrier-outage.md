# Runbook: carrier outage

With `carrierFailover` enabled, the selector skips carriers marked
unhealthy and falls through to the next one in priority order
(ParcelHop, Northwind, Bluefreight).

1. Confirm the outage on the carrier status page.
2. Mark the carrier unhealthy (ops console, or restart the gateway with the
   carrier removed from `carriers.adapters`).
3. Quotes created during the outage carry the fallback carrier; already
   booked shipments are unaffected.
4. When the carrier recovers, mark it healthy and watch tracking polls for
   backlog.
