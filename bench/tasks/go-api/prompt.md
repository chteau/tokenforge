Finance needs to be able to refund customers through the API. Add an endpoint for partial and full refunds of paid invoices, built into the existing service the same way as the other invoice actions.

## Endpoint

`POST /v1/invoices/{id}/refunds`

Request body:

```json
{ "amount_cents": 2500, "reason": "Seat removed" }
```

Successful response: **201 Created** with the refund:

```json
{
  "id": "ref_3f9a0c1b2d4e5f60",
  "invoice_id": "inv_...",
  "amount_cents": 2500,
  "reason": "Seat removed",
  "refunded_by": "usr_...",
  "created_at": "2026-06-10T10:30:00Z"
}
```

`id` uses the `ref_` prefix, `refunded_by` is the ID of the calling user, and `created_at` is the time the refund was made.

## Rules

Check these in this order, using the same error envelope and status-code conventions as the existing invoice endpoints:

1. **Authentication.** A missing or invalid bearer token gets `401`.
2. **Visibility and permission.** These match the other invoice actions, such as issuing or voiding:
   - an unknown invoice, or an invoice the caller cannot see, gets `404` with error code `invoice_not_found`;
   - the invoice's own customer can see the invoice but cannot refund it, and gets `403`;
   - billing admins and admins may refund.
3. **Validation** gets `422` with error code `validation_failed` and a per-field entry in `fields`:
   - `amount_cents` must be greater than zero;
   - `reason` is required, must not be blank, and can be at most 500 characters.
4. **Invoice state.** Only invoices in status `paid` can be refunded. Anything else (`draft`, `open`, including partially paid, `void`, or already fully `refunded`) gets `409` with error code `invoice_not_refundable`.
5. **Amount limit.** The total refunded must never exceed the amount paid. A refund larger than the remaining refundable amount (`paid_cents - refunded_cents`) gets `422` with error code `amount_exceeds_refundable`. This must also hold when several refund requests for the same invoice arrive concurrently.

A rejected request must not change anything.

## Effects of a successful refund

- The invoice representation, wherever an invoice is returned, gets a new integer field `refunded_cents`. It is always present and is `0` for invoices that were never refunded. Each refund increases it.
- A partially refunded invoice stays `paid`. When `refunded_cents` reaches `paid_cents`, the invoice status becomes `refunded`. `GET /v1/invoices?status=refunded` must accept the new status and filter by it.
- An audit event is recorded with action `invoice.refunded`, `target_type` `invoice`, `target_id` set to the invoice ID, and `actor_id` set to the caller. Its `metadata` holds `refund_id` and `amount_cents` (the amount as a decimal string). Rejected requests are not audited.
- The invoice's customer gets an e-mail. Its subject contains `Refund` and the invoice number (for example `Refund issued for invoice INV-000042`), and its body states the refunded amount formatted like the other billing e-mails (for example `€15.00`). As with the existing notifications, a failed delivery must not fail the request.

Follow the existing architecture and conventions of the codebase, add tests for the new behaviour, and keep the API documentation up to date.
