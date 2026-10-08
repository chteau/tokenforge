// Memory graph: sessions, files and keywords from past Claude Code sessions, as a force-directed canvas.
// Small graphs (a few hundred nodes), so a plain O(n²) layout is fine. Colors follow the node type.
const TYPE = {
  session: { color: '--s1', r: 7, label: 'Session' },
  file: { color: '--s2', r: 4.5, label: 'File' },
  keyword: { color: '--s3', r: 5, label: 'Keyword' },
};
export const MEM_TYPES = TYPE;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function renderMemGraph(canvas, g, { onSelect, onHover } = {}) {
  const ctx = canvas.getContext('2d');
  const byId = new Map(g.nodes.map((n, i) => [n.id, Object.assign(n, { i, x: Math.cos(i) * 200 * Math.random(), y: Math.sin(i) * 200 * Math.random(), vx: 0, vy: 0, deg: 0 })]));
  const links = g.links.filter((l) => byId.has(l.source) && byId.has(l.target)).map((l) => ({ ...l, s: byId.get(l.source), t: byId.get(l.target) }));
  for (const l of links) (l.s.deg++, l.t.deg++);
  const nodes = [...byId.values()];
  const adj = new Map(nodes.map((n) => [n, new Set()]));
  for (const l of links) (adj.get(l.s).add(l.t), adj.get(l.t).add(l.s));
  let view = { x: 0, y: 0, k: 1 };
  let hover = null;
  let selected = null;
  let filter = null;
  let alpha = 1;
  let raf = 0;
  const colors = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [k, css(v.color)]));
  const ink = css('--text-secondary');
  const muted = css('--muted');

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function tick() {
    const rep = 900;
    for (let a = 0; a < nodes.length; a++) {
      const n = nodes[a];
      for (let b = a + 1; b < nodes.length; b++) {
        const m = nodes[b];
        let dx = n.x - m.x;
        let dy = n.y - m.y;
        let d2 = dx * dx + dy * dy || 0.01;
        if (d2 > 160000) continue;
        const f = (rep * alpha) / d2;
        n.vx += dx * f;
        n.vy += dy * f;
        m.vx -= dx * f;
        m.vy -= dy * f;
      }
    }
    for (const l of links) {
      const dx = l.t.x - l.s.x;
      const dy = l.t.y - l.s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const want = l.kind === 'edited' ? 46 : 70;
      const f = ((d - want) / d) * 0.04 * alpha;
      l.s.vx += dx * f;
      l.s.vy += dy * f;
      l.t.vx -= dx * f;
      l.t.vy -= dy * f;
    }
    for (const n of nodes) {
      if (n === drag?.node) continue;
      n.vx -= n.x * 0.004 * alpha;
      n.vy -= n.y * 0.004 * alpha;
      n.x += n.vx *= 0.6;
      n.y += n.vy *= 0.6;
    }
    alpha *= 0.985;
  }

  const visible = (n) => !filter || filter(n);
  const radius = (n) => TYPE[n.type].r + Math.min(6, Math.sqrt(n.deg));

  function draw() {
    const { width, height } = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2 + view.x, height / 2 + view.y);
    ctx.scale(view.k, view.k);
    const focus = hover || selected;
    const near = focus ? adj.get(focus) : null;
    ctx.lineWidth = 1 / view.k;
    for (const l of links) {
      if (!visible(l.s) || !visible(l.t)) continue;
      const on = focus && (l.s === focus || l.t === focus);
      ctx.strokeStyle = on ? ink : muted;
      ctx.globalAlpha = on ? 0.8 : focus ? 0.06 : 0.18;
      ctx.beginPath();
      ctx.moveTo(l.s.x, l.s.y);
      ctx.lineTo(l.t.x, l.t.y);
      ctx.stroke();
    }
    for (const n of nodes) {
      if (!visible(n)) continue;
      const dim = focus && n !== focus && !near.has(n);
      ctx.globalAlpha = dim ? 0.15 : 1;
      ctx.fillStyle = colors[n.type];
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2);
      ctx.fill();
      if (n === selected) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2 / view.k;
        ctx.stroke();
        ctx.lineWidth = 1 / view.k;
      }
      const showLabel = n === focus || (near && near.has(n)) || (n.type === 'keyword' && view.k > 0.7 && !focus) || (n.type === 'session' && view.k > 1.6 && !focus);
      if (showLabel && !dim) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = ink;
        ctx.font = `${12 / view.k}px system-ui, sans-serif`;
        const text = n.type === 'file' ? n.label.split('/').pop() : n.label.length > 42 ? n.label.slice(0, 40) + '…' : n.label;
        ctx.fillText(text, n.x + radius(n) + 4 / view.k, n.y + 4 / view.k);
      }
    }
    ctx.restore();
  }

  function loop() {
    if (alpha > 0.02 || drag) tick();
    draw();
    raf = alpha > 0.02 || drag ? requestAnimationFrame(loop) : 0;
  }
  const kick = (a = 0.3) => {
    alpha = Math.max(alpha, a);
    if (!raf) raf = requestAnimationFrame(loop);
  };

  const toWorld = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left - r.width / 2 - view.x) / view.k, y: (ev.clientY - r.top - r.height / 2 - view.y) / view.k };
  };
  const pick = (ev) => {
    const p = toWorld(ev);
    let best = null;
    let bd = Infinity;
    for (const n of nodes) {
      if (!visible(n)) continue;
      const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
      const r = radius(n) + 4 / view.k;
      if (d < r * r && d < bd) (best = n), (bd = d);
    }
    return best;
  };

  let drag = null;
  const onDown = (ev) => {
    const n = pick(ev);
    drag = { node: n, x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onMove = (ev) => {
    if (drag) {
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.node) {
        const p = toWorld(ev);
        Object.assign(drag.node, { x: p.x, y: p.y, vx: 0, vy: 0 });
        kick(0.1);
      } else {
        view.x = drag.vx + dx;
        view.y = drag.vy + dy;
        draw();
      }
      return;
    }
    const n = pick(ev);
    if (n !== hover) {
      hover = n;
      canvas.style.cursor = n ? 'pointer' : 'grab';
      draw();
    }
    onHover?.(n, ev);
  };
  const onUp = (ev) => {
    if (drag && !drag.moved) {
      selected = pick(ev);
      onSelect?.(selected);
      draw();
    }
    drag = null;
  };
  const onWheel = (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left - r.width / 2;
    const my = ev.clientY - r.top - r.height / 2;
    const k = Math.min(4, Math.max(0.2, view.k * Math.exp(-ev.deltaY * 0.0015)));
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
    draw();
  };
  const onLeave = () => {
    hover = null;
    onHover?.(null);
    draw();
  };
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mouseleave', onLeave);
  window.addEventListener('resize', resize);
  resize();
  for (let i = 0; i < 120; i++) tick(); // settle before the first frame
  kick(0.4);

  return {
    neighborsOf: (n) => [...(adj.get(n) || [])],
    select: (n) => ((selected = n), draw()),
    setFilter: (f) => ((filter = f), draw()),
    nodeCount: nodes.length,
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', resize);
    },
  };
}
