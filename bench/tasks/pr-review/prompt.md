Review the pull request on the current branch (`feature/invoice-export`) against `main`. You can see it with `git diff main...HEAD`. Report the issues that should block merging: bugs, security problems, and violations of the codebase's established conventions. Don't report style nits or speculative improvements.

Write your review to `review.json` in the repository root. It must be a JSON array with one object per issue and these keys:

- `file`: path relative to the repository root, e.g. `internal/services/exports.go`
- `line`: integer line number in the PR branch's version of the file
- `severity`: one of `critical`, `high`, `medium`, `low`
- `title`: a short summary
- `explanation`: what is wrong, why it matters, and how to fix it

Do not modify any other files.
