This repository contains the LaTeX source of a statistics manuscript that is about to be submitted: `main.tex` (title, abstract and document structure), the sections in `sections/`, the figures in `figures/` and the bibliography in `refs.bib`.

Proofread the whole manuscript and list every error and inconsistency in `review.json`. This includes, for example, numbers in the text that disagree with a table or with another section, equations that are inconsistent with how they are used, wrong cross-references or citations, claims that contradict other parts of the paper, wrong units, duplicated text, and typos or wording errors that change the meaning. Do not report pure style preferences or LaTeX formatting nits.

Write `review.json` in the repository root. It must be a JSON array with one object per error and these keys:

- `file`: path relative to the repository root, e.g. `sections/methods.tex`
- `line`: integer line number in that file where the error is (for an inconsistency between two places, use the place that is wrong)
- `category`: a short label such as `numeric`, `equation`, `cross-reference`, `citation`, `contradiction`, `units`, `duplication`, `typo`
- `description`: what is wrong and what the correct text should be

Do not modify any other files.
