# Refactor: one source of truth for entry validation

The rules that decide whether an entry's fields are acceptable (date range, amount limits, category/payee/note/tag rules and their normalisation) are implemented separately in several places: when adding an entry, when editing one, when renaming a category and when importing a bank file. The copies have drifted apart over time, so some commands accept values that others reject, and the same mistake can produce different error messages depending on the command.

Please refactor so that these rules live in exactly one place and every command that creates or changes entries goes through it.

Where the copies disagree, the behaviour of `tally add` is the correct one: its rules, its normalisation (trimming, lower-casing, tag handling) and its exact error messages should apply to every command, including the `line N: ` prefix that import already puts in front of errors. Behaviour that is specific to a command and not a validation rule must stay as it is, for example import shortening long bank descriptions before they become payees, `rename-category` matching the old name case-insensitively, or its "old and new category are the same" check.

Keep the change focused: no unrelated rewrites, no changes to the CLI, file formats or output. Make sure the existing tests still pass, and add tests that pin down the now-consistent behaviour.
