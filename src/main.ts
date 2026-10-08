import './style.css';
import { benchmark } from './pages/benchmark';
import { docs, DOCS } from './pages/docs';
import { home } from './pages/home';
import { hideTip } from './util';

// Hash routes work on GitHub Pages without server rewrites: #/, #/benchmark, #/docs/<slug>.
const ICONS = {
  home: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 1h6v6H1zM9 1h6v6H9zM1 9h6v6H1zM9 9h6v6H9z"/></svg>',
  benchmark: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 14h14v1.5H1zM2 8h3v5H2zM6.5 4h3v9h-3zM11 1h3v12h-3z"/></svg>',
  docs: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 1h9l3 3v11H2zM4 6h8v1.4H4zm0 3h8v1.4H4zm0 3h5v1.4H4z"/></svg>',
  github: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 .5a7.5 7.5 0 0 0-2.4 14.6c.4.1.5-.2.5-.4v-1.4c-2.1.5-2.5-.9-2.5-.9-.4-.9-.9-1.1-.9-1.1-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.8.8 2.3.6.1-.5.3-.8.5-1-1.7-.2-3.4-.8-3.4-3.7 0-.8.3-1.5.8-2-.1-.2-.3-1 .1-2 0 0 .6-.2 2.1.8a7 7 0 0 1 3.8 0c1.4-1 2.1-.8 2.1-.8.4 1 .2 1.8.1 2 .5.5.8 1.2.8 2 0 2.9-1.8 3.5-3.4 3.7.3.2.5.7.5 1.4v2.1c0 .2.1.5.5.4A7.5 7.5 0 0 0 8 .5z"/></svg>',
};

const nav = document.getElementById('nav') as HTMLElement;
const sub = document.getElementById('side-sub') as HTMLElement;
const view = document.getElementById('view') as HTMLElement;

nav.innerHTML = [
  ['home', '#/', 'Home'],
  ['benchmark', '#/benchmark', 'Benchmark'],
  ['docs', '#/docs/install', 'Docs'],
  ['github', 'https://github.com/chteau/tokenforge', 'GitHub'],
].map(([k, href, label]) => `<a href="${href}" data-k="${k}"><span class="ico">${ICONS[k as keyof typeof ICONS]}</span>${label}</a>`).join('');

let lastRoute = '';
function route(): void {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page = '', slug = ''] = hash.split('/');
  const key = page === 'benchmark' ? 'benchmark' : page === 'docs' ? 'docs' : 'home';
  const routeId = `${key}/${slug}`;
  if (routeId === lastRoute) return;
  const samePage = lastRoute.split('/')[0] === key;
  lastRoute = routeId;
  hideTip();

  nav.querySelectorAll('a').forEach((a) => {
    if (a.dataset.k === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  sub.innerHTML = key === 'docs'
    ? DOCS.map((d) => `<a href="#/docs/${d.slug}"${d.slug === (slug || 'install') ? ' class="on" aria-current="page"' : ''}>${d.title}</a>`).join('')
    : '';

  if (key === 'benchmark') { benchmark(view); document.title = 'Benchmark · TokenForge'; }
  else if (key === 'docs') {
    docs(view, slug || 'install');
    document.title = `${DOCS.find((d) => d.slug === slug)?.title ?? DOCS[0]?.title} · TokenForge docs`;
  } else { home(view); document.title = 'TokenForge'; }

  window.scrollTo({ top: 0, behavior: samePage ? 'smooth' : 'auto' });
  if (lastRoute && document.activeElement !== document.body) view.focus({ preventScroll: true });
}

window.addEventListener('hashchange', route);
route();
