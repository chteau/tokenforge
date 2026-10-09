# TokenForge website

Source of the TokenForge site, served by GitHub Pages at `https://chteau.github.io/tokenforge/`. This orphan `site` branch holds only the website. The plugin itself is on `master`.

Built with Vite and TypeScript (strict). There is no framework and no chart library: the charts are plain SVG drawn in `src/charts/`.

## Develop

```bash
npm install
npm run dev       # http://localhost:5173/tokenforge/
npm run build     # type-check, then build to dist/
npm run preview   # serve dist/ under /tokenforge/
```

Pages use hash routes (`#/`, `#/benchmark`, `#/docs/<page>`, `#/roadmap`), so they work on GitHub Pages without server rewrites.

## Data

Every number on the site comes from `src/data/bench.json`. That file is generated from the plugin repo's benchmark and committed, because CI has no access to the raw benchmark runs.

Regenerate it from a checkout of the plugin's `master` branch:

```bash
node scripts/extract-data.mjs ../tokenforge      # or: TOKENFORGE_REPO=/path/to/tokenforge npm run data
```

The script reads:

- `bench/reports/benchmark-report.json`: per-task medians, aggregate stats and the models seen in API responses
- `bench/tasks/*/task.json`: task titles and languages
- `bench/scripts/charts.py`: the measured fixed context per lean level (`FLOOR`)
- the transcripts of the two `rust-cli` runs the report uses (found by session id): context per API request, deduplicated by `requestId`

Docs text comes from the plugin's `README.md` and `CHANGELOG.md`.

## Deploy

`.github/workflows/pages.yml` builds and deploys on every push to `site` (or a manual run). In the repo settings, set Pages → Source to "GitHub Actions".
