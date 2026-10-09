# Contributing

Bug reports, measurements and small, focused pull requests are all welcome.

## Setup

You need Node.js 20 or newer, plus Rust if you change `native/tmap`.

```
git clone https://github.com/chteau/tokenforge
cd tokenforge
claude --plugin-dir .           # run Claude Code with your clone as the plugin
```

If tokenforge is also installed from the marketplace, disable that copy in `/plugin` while you test.

Hooks run straight from your clone, so an edit to hook code reaches every session using it on its next hook call. Plugins load when Claude Code starts: after changing `hooks/hooks.json`, start a new session (`/clear` is not enough). After changing `lib/ui-server.mjs` or `lib/insights.mjs`, restart the dashboard with `node bin/tforge ui --stop` and `node bin/tforge ui --detach`.

## Checks

```
npm test                        # unit and end-to-end tests with a fake claude binary
cargo test --release --manifest-path native/tmap/Cargo.toml -- --test-threads=1
claude plugin validate .        # check the manifests
```

CI runs the Node tests on Linux and macOS (Node 20, 22 and 24), a smoke test on Windows, and the tmap tests on all three. To check a Rust change for Windows from Linux, run `cargo xwin check --release --tests --target x86_64-pc-windows-msvc --manifest-path native/tmap/Cargo.toml`.

## Ground rules

- **Measure savings.** A change meant to save tokens needs numbers: an A/B run with `bench/` (the method is in `bench/README.md`), or at least `tforge meter` before and after on the same task. Many ideas that look cheaper turned out not to be.
- **Don't get in the way.** On an error, a hook lets the call through. Hooks never hold a prompt, and messages shown to the user stay rare and short.
- **Keep reads whole.** Never shorten what Claude reads from documents: no folding prose, no replaying cached answers to review prompts. People use tokenforge for proofreading and audits.
- **Windows too.** Paths, shells and processes must work on Windows as well as Linux and macOS.
- **No npm packages.** The plugin runs as installed, without `npm install`, so it uses Node built-ins only.
- Match the surrounding code, and add a test with a fix or a new behaviour.

## Pull requests

Keep each pull request to one change, and say what users will notice. Versions and `CHANGELOG.md` are updated at release.

## Issues

Use the bug report or feature request form. Transcripts, `.forge/` files and logs can contain your code and prompts: remove anything private before posting.
