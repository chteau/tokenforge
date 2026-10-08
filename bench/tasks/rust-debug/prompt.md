# Totals don't update after correcting an amount

I noticed that `tally categories` and `tally report monthly` sometimes keep showing old numbers after I fix an entry, while `tally list` shows the corrected entry.

How to reproduce (fresh data directory):

```console
$ tally init
$ tally add 2026-01-03 12.50 groceries
added entry 1
$ tally categories
CATEGORY   COUNT  EXPENSES  INCOME
groceries      1    $12.50   $0.00
$ tally edit 1 --amount 13.50
updated entry 1
$ tally list
ID  DATE        CATEGORY   AMOUNT  PAYEE  TAGS  NOTE
 1  2026-01-03  groceries  -$13.50
...
$ tally categories
CATEGORY   COUNT  EXPENSES  INCOME
groceries      1    $12.50   $0.00      <-- still the old amount
```

`tally report monthly` shows the old total as well, whereas `tally report categories` shows the right one. It doesn't happen every time: when I changed the same entry to `113.50` instead, the totals were correct. I think I've also seen it after renaming a category, and after fixing a typo directly in `ledger.txt` with my editor. Adding or removing entries always seems to work.

Please find out what is actually going on and fix it properly, so the totals are always right no matter how the ledger was changed, and add a regression test. My real ledger covers many years, so please keep the summary cache working instead of switching it off.
