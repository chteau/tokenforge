// Fixture for `tmap kit pdf`: `typst compile paper.typ` (3 pages, two columns, forced hyphen break, equation, table).
#set page(paper: "a4", columns: 2, margin: 2cm)
#set text(font: "Libertinus Serif", size: 10pt, lang: "en")
#set par(justify: true)
#place(top + center, float: true, scope: "parent")[
  #text(17pt)[*Token Budgets for Reading Papers*] \
  Alice Example and Bob Sample
]

= Introduction
Large language models read scientific papers as page images, which is an exam-#linebreak()ple of wasted context. #lorem(160)

The energy of a body at rest is given by the well known relation
$ E = m c^2 $
which we use throughout. #lorem(140)

= Method
#lorem(220)

#figure(
  table(columns: 3,
    [Model], [Tokens], [Accuracy],
    [Image], [2400], [0.91],
    [Text], [610], [0.93],
  ),
  caption: [Token cost per page.],
)

#lorem(260)

= Results
#lorem(300)

= Discussion
#lorem(320)

= Conclusion
The column-sentinel paragraph closes the paper. #lorem(200)
