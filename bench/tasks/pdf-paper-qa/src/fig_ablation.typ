#set page(width: auto, height: auto, margin: 3mm, fill: white)
#set text(size: 9pt, font: "Libertinus Serif")
#let data = (("Full model", 6.84), ("w/o phase loss", 7.12), ("w/o surge head", 7.35), ("w/o tidal sparse attn.", 7.71), ("w/o harmonic emb.", 8.92), ("w/o station emb.", 7.28))
#let W = 9cm
#let H = 5.2cm
#let ymin = 6.0
#let ymax = 9.5
#let bw = W / data.len()
#box(width: W + 1.2cm, height: H + 1.5cm, {
  place(dx: 1.1cm, rect(width: W, height: H, stroke: 0.5pt))
  for v in (6.0, 7.0, 8.0, 9.0) {
    let y = H - (v - ymin) / (ymax - ymin) * H
    place(dx: 1.1cm, dy: y, line(length: W, stroke: (paint: luma(200), dash: "dotted")))
    place(dx: 0.3cm, dy: y - 0.17cm, [#str(v)])
  }
  place(dx: -0.25cm, dy: 0cm, rotate(-90deg, reflow: true, box(height: 0.4cm, width: H, align(center)[MAE (cm)])))
  for (i, (lab, v)) in data.enumerate() {
    let h = (v - ymin) / (ymax - ymin) * H
    let x = 1.1cm + i * bw + bw * 0.18
    place(dx: x, dy: H - h, rect(width: bw * 0.64, height: h, fill: if i == 0 { rgb("#2b6cb0") } else { rgb("#a0aec0") }, stroke: 0.4pt))
    place(dx: x - 0.1cm, dy: H - h - 0.42cm, box(width: bw * 0.64 + 0.2cm, align(center, text(size: 8pt)[#str(v)])))
    place(dx: 1.1cm + i * bw, dy: H + 0.12cm, box(width: bw, align(center, text(size: 7.5pt, lab))))
  }
})
