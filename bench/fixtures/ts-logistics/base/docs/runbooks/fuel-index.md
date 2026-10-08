# Runbook: monthly fuel index update

1. Operations publishes the new index on the last working day of the month.
2. Update `rates.fuelIndexBps` in `config/production.json` (basis points;
   12.10% = 1210).
3. Deploy the gateway and worker. Open quotes keep their old price until
   they expire.
4. Post in #pricing with the old and new value.

Rollback: revert the config change and redeploy.
