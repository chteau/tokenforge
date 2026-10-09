import './style.css';
import { benchmark } from './pages/benchmark';
import { docs, DOCS } from './pages/docs';
import { home } from './pages/home';
import { roadmap } from './pages/roadmap';
import { hideTip } from './util';

// Hash routes work on GitHub Pages without server rewrites: #/, #/benchmark, #/docs/<slug>, #/roadmap.
const GITHUB = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 .5a7.5 7.5 0 0 0-2.4 14.6c.4.1.5-.2.5-.4v-1.4c-2.1.5-2.5-.9-2.5-.9-.4-.9-.9-1.1-.9-1.1-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.8.8 2.3.6.1-.5.3-.8.5-1-1.7-.2-3.4-.8-3.4-3.7 0-.8.3-1.5.8-2-.1-.2-.3-1 .1-2 0 0 .6-.2 2.1.8a7 7 0 0 1 3.8 0c1.4-1 2.1-.8 2.1-.8.4 1 .2 1.8.1 2 .5.5.8 1.2.8 2 0 2.9-1.8 3.5-3.4 3.7.3.2.5.7.5 1.4v2.1c0 .2.1.5.5.4A7.5 7.5 0 0 0 8 .5z"/></svg>';

const nav = document.getElementById('nav') as HTMLElement;
const view = document.getElementById('view') as HTMLElement;

nav.innerHTML = [
  ['home', '#/', 'Home'],
  ['benchmark', '#/benchmark', 'Benchmark'],
  ['docs', '#/docs/install', 'Docs'],
  ['roadmap', '#/roadmap', 'Roadmap'],
].map(([k, href, label]) => `<a href="${href}" data-k="${k}">${label}</a>`).join('')
  + `<a class="gh" href="https://github.com/chteau/tokenforge" aria-label="GitHub">${GITHUB}<span>GitHub</span></a>`;

let lastRoute = '';
function route(): void {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page = '', slug = ''] = hash.split('/');
  const key = ['benchmark', 'docs', 'roadmap'].includes(page) ? page : 'home';
  const routeId = `${key}/${slug}`;
  if (routeId === lastRoute) return;
  const samePage = lastRoute.split('/')[0] === key;
  lastRoute = routeId;
  hideTip();

  nav.querySelectorAll('a').forEach((a) => {
    if (a.dataset.k === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  if (key === 'benchmark') { benchmark(view); document.title = 'Benchmark · TokenForge'; }
  else if (key === 'docs') {
    docs(view, slug || 'install');
    document.title = `${DOCS.find((d) => d.slug === slug)?.title ?? DOCS[0]?.title} · TokenForge docs`;
  } else if (key === 'roadmap') { roadmap(view); document.title = 'Roadmap · TokenForge'; }
  else { home(view); document.title = 'TokenForge'; }

  window.scrollTo({ top: 0, behavior: samePage ? 'smooth' : 'auto' });
  if (lastRoute && document.activeElement !== document.body) view.focus({ preventScroll: true });
}

window.addEventListener('hashchange', route);
route();
