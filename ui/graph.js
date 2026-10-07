// Force-directed code graph on canvas: folders and files as glowing nodes, tree links, optional call links.
// Barnes-Hut repulsion keeps ~2k nodes interactive without libraries.

export const LANG = [
  { key: 'rs', label: 'Rust', color: '#d16a47', test: /\.rs$/ },
  { key: 'ts', label: 'TypeScript', color: '#3f8fd8', test: /\.(ts|tsx|mts|cts)$/ },
  { key: 'js', label: 'JavaScript', color: '#b98a12', test: /\.(js|jsx|mjs|cjs)$/ },
  { key: 'py', label: 'Python', color: '#8c74e6', test: /\.pyi?$/ },
  { key: 'go', label: 'Go', color: '#2fa39a', test: /\.go$/ },
];
const OTHER = '#8f8d86';
const DIR = '#e8e4d8';
const ROOT = '#d16a47';
export const langOf = (p) => LANG.find((l) => l.test.test(p)) || null;

function buildModel(g, rootName) {
  const nodes = [];
  const links = [];
  const byPath = new Map();
  const root = { id: 0, kind: 'root', name: rootName, path: '', lines: 0, files: 0, syms: 0, inbound: 0, outbound: 0, kids: [] };
  nodes.push(root);
  byPath.set('', root);
  const dirOf = (path) => {
    if (byPath.has(path)) return byPath.get(path);
    const cut = path.lastIndexOf('/');
    const parent = dirOf(cut < 0 ? '' : path.slice(0, cut));
    const n = { id: nodes.length, kind: 'dir', name: path.slice(cut + 1), path, lines: 0, files: 0, syms: 0, inbound: 0, outbound: 0, kids: [], parent };
    nodes.push(n);
    byPath.set(path, n);
    parent.kids.push(n);
    links.push({ s: parent, t: n, kind: 'tree' });
    return n;
  };
  const fileNodes = g.files.map((f) => {
    const cut = f.p.lastIndexOf('/');
    const parent = dirOf(cut < 0 ? '' : f.p.slice(0, cut));
    const n = { id: nodes.length, kind: 'file', name: f.p.slice(cut + 1), path: f.p, lines: f.l, files: 1, syms: f.s, top: f.t, inbound: 0, outbound: 0, kids: [], parent, lang: langOf(f.p) };
    nodes.push(n);
    parent.kids.push(n);
    links.push({ s: parent, t: n, kind: 'tree' });
    for (let p = parent; p; p = p.parent) {
      p.lines += f.l;
      p.files++;
      p.syms += f.s;
    }
    return n;
  });
  const calls = [];
  for (const [a, b, w] of g.edges) {
    const s = fileNodes[a];
    const t = fileNodes[b];
    s.outbound += w;
    t.inbound += w;
    calls.push({ s, t, w, kind: 'call' });
  }
  calls.sort((x, y) => y.w - x.w);
  for (const n of nodes) {
    n.r = n.kind === 'root' ? 9 : n.kind === 'dir' ? 3.5 + Math.min(7, Math.sqrt(n.files) * 0.9) : 2.2 + Math.min(6, Math.sqrt(n.lines) / 9);
    n.color = n.kind === 'root' ? ROOT : n.kind === 'dir' ? DIR : n.lang ? n.lang.color : OTHER;
    n.deg = 0;
  }
  for (const l of links) {
    l.s.deg++;
    l.t.deg++;
  }
  // Seed positions radially by subtree size so the layout starts close to a tree and settles fast.
  const leaves = (n) => (n.leafCount ??= n.kids.length ? n.kids.reduce((a, k) => a + leaves(k), 0) : 1);
  const place = (n, a0, a1, depth) => {
    const a = (a0 + a1) / 2;
    const rad = depth * 70;
    n.x = Math.cos(a) * rad + (Math.random() - 0.5) * 4;
    n.y = Math.sin(a) * rad + (Math.random() - 0.5) * 4;
    n.vx = 0;
    n.vy = 0;
    let cur = a0;
    const total = leaves(n);
    for (const k of n.kids) {
      const span = ((a1 - a0) * leaves(k)) / total;
      place(k, cur, cur + span, depth + 1);
      cur += span;
    }
  };
  place(root, 0, Math.PI * 2, 0);
  return { nodes, links, calls, root };
}

// ---- Barnes-Hut quadtree ----
function buildTree(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.x > x1) x1 = n.x;
    if (n.y > y1) y1 = n.y;
  }
  const size = Math.max(x1 - x0, y1 - y0) + 1;
  const root = { x0, y0, size, mass: 0, cx: 0, cy: 0, kids: null, node: null };
  const insert = (cell, n, depth) => {
    if (!cell.kids && !cell.node) {
      cell.node = n;
    } else {
      if (!cell.kids) {
        if (depth > 40) return; // coincident points: drop into this cell's mass only
        cell.kids = [null, null, null, null];
        const old = cell.node;
        cell.node = null;
        insertKid(cell, old, depth);
      }
      insertKid(cell, n, depth);
    }
    cell.cx = (cell.cx * cell.mass + n.x * n.charge) / (cell.mass + n.charge);
    cell.cy = (cell.cy * cell.mass + n.y * n.charge) / (cell.mass + n.charge);
    cell.mass += n.charge;
  };
  const insertKid = (cell, n, depth) => {
    const h = cell.size / 2;
    const i = (n.x >= cell.x0 + h ? 1 : 0) + (n.y >= cell.y0 + h ? 2 : 0);
    if (!cell.kids[i]) cell.kids[i] = { x0: cell.x0 + (i & 1 ? h : 0), y0: cell.y0 + (i & 2 ? h : 0), size: h, mass: 0, cx: 0, cy: 0, kids: null, node: null };
    insert(cell.kids[i], n, depth + 1);
  };
  for (const n of nodes) insert(root, n, 0);
  return root;
}

function repel(cell, n, alpha, theta2) {
  if (!cell || cell.mass === 0 || cell.node === n) return;
  let dx = cell.cx - n.x;
  let dy = cell.cy - n.y;
  let d2 = dx * dx + dy * dy;
  if (cell.kids && (cell.size * cell.size) / (d2 || 1e-6) > theta2) {
    for (const k of cell.kids) repel(k, n, alpha, theta2);
    return;
  }
  if (d2 > 640000) return;
  if (d2 < 1) {
    dx = (Math.random() - 0.5) || 0.1;
    dy = (Math.random() - 0.5) || 0.1;
    d2 = dx * dx + dy * dy;
  }
  const f = (-34 * cell.mass * alpha) / d2;
  n.vx += dx * f;
  n.vy += dy * f;
}

export function renderGraph(canvas, g, { rootName = '.', onSelect, onHover } = {}) {
  const ctx = canvas.getContext('2d');
  const model = buildModel(g, rootName);
  const { nodes, links, calls } = model;
  for (const n of nodes) n.charge = n.kind === 'file' ? 1 : 1.6 + n.r / 4;
  let alpha = 1;
  let W = 0, H = 0, dpr = 1;
  const view = { x: 0, y: 0, k: 0.55 };
  let hover = null;
  let selected = null;
  let highlight = null; // Set of node ids from search
  let showCalls = false;
  let showFileLabels = true;
  let drag = null;
  let raf = 0;
  let stopped = false;
  let userMoved = false;

  // Pre-rendered radial glow per color, drawn additively.
  const sprites = new Map();
  const glow = (color) => {
    if (sprites.has(color)) return sprites.get(color);
    const s = document.createElement('canvas');
    s.width = s.height = 64;
    const c = s.getContext('2d');
    const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, color + 'aa');
    gr.addColorStop(0.35, color + '44');
    gr.addColorStop(1, color + '00');
    c.fillStyle = gr;
    c.fillRect(0, 0, 64, 64);
    sprites.set(color, s);
    return s;
  };

  const neighbors = new Map(nodes.map((n) => [n, new Set()]));
  for (const l of links) {
    neighbors.get(l.s).add(l.t);
    neighbors.get(l.t).add(l.s);
  }
  for (const l of calls.slice(0, 4000)) {
    neighbors.get(l.s).add(l.t);
    neighbors.get(l.t).add(l.s);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    draw();
  }

  function tick() {
    const tree = buildTree(nodes);
    const theta2 = 0.81;
    for (const n of nodes) repel(tree, n, alpha, theta2);
    for (const l of links) {
      const dx = l.t.x + l.t.vx - l.s.x - l.s.vx;
      const dy = l.t.y + l.t.vy - l.s.y - l.s.vy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = (l.t.kind === 'dir' ? 46 : 20) + l.s.r + l.t.r;
      const strength = 0.7 / Math.min(l.s.deg, l.t.deg);
      const f = ((d - rest) / d) * alpha * strength;
      const bias = l.s.deg / (l.s.deg + l.t.deg);
      l.t.vx -= dx * f * bias;
      l.t.vy -= dy * f * bias;
      l.s.vx += dx * f * (1 - bias);
      l.s.vy += dy * f * (1 - bias);
    }
    for (const n of nodes) {
      n.vx -= n.x * 0.0025 * alpha;
      n.vy -= n.y * 0.0025 * alpha;
      if (n.fx != null) {
        n.x = n.fx;
        n.y = n.fy;
        n.vx = n.vy = 0;
        continue;
      }
      n.vx *= 0.58;
      n.vy *= 0.58;
      n.x += n.vx;
      n.y += n.vy;
    }
    alpha += (0 - alpha) * 0.018;
  }

  const toScreen = (n) => [W / 2 + view.x + n.x * view.k, H / 2 + view.y + n.y * view.k];
  const toWorld = (sx, sy) => [(sx - W / 2 - view.x) / view.k, (sy - H / 2 - view.y) / view.k];

  function focusSet() {
    if (hover) return new Set([hover, ...neighbors.get(hover)]);
    if (selected) return new Set([selected, ...neighbors.get(selected)]);
    if (highlight) return new Set(nodes.filter((n) => highlight.has(n.id)));
    return null;
  }

  function draw() {
    if (!W) return;
    const focus = focusSet();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * (W / 2 + view.x), dpr * (H / 2 + view.y));
    // tree links
    ctx.lineWidth = 1 / view.k;
    ctx.strokeStyle = focus ? 'rgba(232,228,216,0.06)' : 'rgba(232,228,216,0.16)';
    ctx.beginPath();
    for (const l of links) {
      ctx.moveTo(l.s.x, l.s.y);
      ctx.lineTo(l.t.x, l.t.y);
    }
    ctx.stroke();
    if (focus) {
      ctx.strokeStyle = 'rgba(232,228,216,0.55)';
      ctx.beginPath();
      for (const l of links) if (focus.has(l.s) && focus.has(l.t)) {
        ctx.moveTo(l.s.x, l.s.y);
        ctx.lineTo(l.t.x, l.t.y);
      }
      ctx.stroke();
    }
    // call links
    const callSet = showCalls ? calls.slice(0, 1500) : focus ? calls.filter((l) => focus.has(l.s) && focus.has(l.t)).slice(0, 300) : [];
    if (callSet.length) {
      const maxW = Math.max(...callSet.map((l) => l.w));
      for (const l of callSet) {
        const lit = focus && focus.has(l.s) && focus.has(l.t);
        ctx.strokeStyle = lit ? 'rgba(209,106,71,0.75)' : `rgba(209,106,71,${focus ? 0.05 : 0.22})`;
        ctx.lineWidth = (0.6 + 2 * Math.sqrt(l.w / maxW)) / view.k;
        ctx.beginPath();
        ctx.moveTo(l.s.x, l.s.y);
        ctx.lineTo(l.t.x, l.t.y);
        ctx.stroke();
      }
    }
    // glow
    ctx.globalCompositeOperation = 'lighter';
    for (const n of nodes) {
      const dim = focus && !focus.has(n);
      if (dim) continue;
      const R = n.r * (n.kind === 'file' ? 5 : 4);
      ctx.globalAlpha = n.kind === 'dir' ? 0.3 : 0.75;
      ctx.drawImage(glow(n.color), n.x - R, n.y - R, R * 2, R * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // nodes
    for (const n of nodes) {
      const dim = focus && !focus.has(n);
      ctx.globalAlpha = dim ? 0.18 : 1;
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      if (n === selected || n === hover) {
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = '#faf9f5';
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // labels in screen space so text stays crisp at any zoom
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'middle';
    for (const n of nodes) {
      const inFocus = focus && focus.has(n);
      const isDir = n.kind !== 'file';
      const show = inFocus || (focus ? false : isDir ? view.k * n.r > 2.2 : showFileLabels && view.k > 1.15);
      if (!show) continue;
      const [sx, sy] = toScreen(n);
      if (sx < -200 || sx > W + 50 || sy < -20 || sy > H + 20) continue;
      ctx.font = `${isDir ? 600 : 400} ${isDir ? 12 : 11}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.fillStyle = inFocus ? '#faf9f5' : isDir ? 'rgba(250,249,245,0.82)' : 'rgba(194,192,182,0.85)';
      const label = n.kind === 'root' ? n.name : isDir ? `${n.name}/` : n.name;
      ctx.fillText(label, sx + n.r * view.k + 5, sy);
    }
  }

  let fitted = false;
  function fitView() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x);
      y1 = Math.max(y1, n.y);
    }
    view.k = Math.min(2, 0.9 * Math.min(W / (x1 - x0 + 1), H / (y1 - y0 + 1)));
    view.x = -((x0 + x1) / 2) * view.k;
    view.y = -((y0 + y1) / 2) * view.k;
  }

  function loop() {
    if (stopped) return;
    if (alpha > 0.004) {
      tick();
      if (alpha < 0.4) tick();
    }
    // Keep the whole graph in view while it settles, until the user takes over.
    if (!fitted && !userMoved) fitView();
    if (alpha < 0.05) fitted = true;
    draw();
    raf = alpha > 0.004 || drag ? requestAnimationFrame(loop) : 0;
  }
  const wake = (a = 0) => {
    alpha = Math.max(alpha, a);
    if (!raf) raf = requestAnimationFrame(loop);
  };

  function pick(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    let best = null;
    let bd = Infinity;
    for (const n of nodes) {
      const d = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      const hit = Math.max(n.r, 6 / view.k);
      if (d < hit * hit && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    const [sx, sy] = pos(e);
    const n = pick(sx, sy);
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
    drag = n ? { node: n, moved: false } : { pan: true, sx, sy, vx: view.x, vy: view.y, moved: false };
    if (n) wake(0.25);
  });
  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = pos(e);
    if (drag) {
      drag.moved = true;
      if (drag.node) {
        const [wx, wy] = toWorld(sx, sy);
        drag.node.fx = wx;
        drag.node.fy = wy;
        wake(0.2);
      } else {
        userMoved = true;
        view.x = drag.vx + sx - drag.sx;
        view.y = drag.vy + sy - drag.sy;
        draw();
      }
      return;
    }
    const n = pick(sx, sy);
    if (n !== hover) {
      hover = n;
      draw();
      onHover && onHover(n, e);
    } else if (n) onHover && onHover(n, e);
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('dragging');
    const d = drag;
    drag = null;
    if (d && d.node) {
      d.node.fx = d.node.fy = null;
    }
    if (d && !d.moved) {
      const [sx, sy] = pos(e);
      selected = pick(sx, sy);
      draw();
      onSelect && onSelect(selected);
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (hover) {
      hover = null;
      draw();
      onHover && onHover(null);
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    userMoved = true;
    const [sx, sy] = pos(e);
    const [wx, wy] = toWorld(sx, sy);
    view.k = Math.min(8, Math.max(0.08, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = sx - W / 2 - wx * view.k;
    view.y = sy - H / 2 - wy * view.k;
    draw();
  }, { passive: false });

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  // Settle the first ticks off-screen so the first frame is already readable.
  for (let i = 0; i < 60; i++) tick();
  wake();

  return {
    nodeCount: nodes.length,
    fileCount: g.files.length,
    callCount: calls.length,
    setShowCalls(v) {
      showCalls = v;
      draw();
    },
    setShowFileLabels(v) {
      showFileLabels = v;
      draw();
    },
    search(q) {
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) {
        highlight = null;
        draw();
        return 0;
      }
      const hits = nodes.filter((n) => n.kind !== 'root' && words.every((w) => n.path.toLowerCase().includes(w) || (n.top || []).some((t) => t.toLowerCase().includes(w))));
      highlight = new Set(hits.map((n) => n.id));
      if (hits.length) {
        userMoved = true;
        const cx = hits.reduce((a, n) => a + n.x, 0) / hits.length;
        const cy = hits.reduce((a, n) => a + n.y, 0) / hits.length;
        view.x = -cx * view.k;
        view.y = -cy * view.k;
      }
      draw();
      return hits.length;
    },
    select(n) {
      selected = n;
      draw();
    },
    fit() {
      fitView();
      draw();
    },
    neighborsOf(n) {
      const inc = calls.filter((l) => l.t === n).sort((a, b) => b.w - a.w);
      const out = calls.filter((l) => l.s === n).sort((a, b) => b.w - a.w);
      return { inc, out };
    },
    destroy() {
      stopped = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
}
