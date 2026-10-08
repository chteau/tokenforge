# ADR-0011: Pricing profiles and adjusters

Status: Proposed (2025-01)

## Context

Every tenant segment (direct, marketplace, contract) needs a slightly
different set of surcharges. Today that is a chain of `if` statements.

## Proposal

- Split surcharges into small _adjuster_ functions with one signature:
  `(ctx) => LineItem[]`.
- A tenant has a `pricingProfile`; config maps each profile to an ordered
  list of adjuster keys.
- The quote service asks a registry for the tenant's chain and runs it
  after the base rate.

## Open questions

- Should adjusters see each other's output (compounding)? Current answer:
  no, all percentage adjusters apply to the base subtotal.
