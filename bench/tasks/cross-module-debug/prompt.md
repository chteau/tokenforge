# Bug report: Overview page shows an old balance after receiving money

**Reported by:** Customer Support (ticket escalated by Sam O.)
**Severity:** High, several customers affected

> "My friend sent me $15 this morning. On the **Activity** page of my Dollar Account the incoming transfer is there and the balance is right. On the **Overview** page the transfer even shows up under *Recent activity*, but the account balance and the USD balance tile still show the old amount. If I come back a few minutes later it is correct. When I move money between my own accounts, or when the bank credits a deposit, the Overview updates straight away."
> (customer Bob, username `bob`)

## Steps to reproduce (demo data)

1. Sign in as `bob` / `bob-harbor-2026` and open the Overview page (`/dashboard`). Note the balance of *Dollar Account* (`QM-1000-0005`): **$365.00**. `GET /api/dashboard` reports `balanceMinor: 36500` for that account.
2. In a separate session sign in as `alice` / `alice-harbor-2026` and send **15.00** from her *Everyday* account to `QM-1000-0005` (the Move money form, or `POST /api/transfers` with an `Idempotency-Key` header).
3. As `bob`, reload the Overview page or call `GET /api/dashboard` again.

**Expected:** Dollar Account shows **$380.00** (`balanceMinor: 38000`), and the USD tile and "In this month" figure include the incoming 15.00.
**Actual:** it still shows $365.00 for several minutes. `GET /api/accounts` and the Activity page already show $380.00.

## Notes from the platform team

The Overview is our most expensive page. A fix that makes every Overview load recompute everything (or that throws away other customers' cached data on every transfer) is not acceptable; please find and fix the actual cause. Add a regression test.
