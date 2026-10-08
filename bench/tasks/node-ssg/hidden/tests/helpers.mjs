// Shared helpers for the black-box checks: run the CLI, read outputs, normalise HTML.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(process.env.SSG_REPO || process.cwd());
export const ENTRY = join(REPO, "bin", "ssg.mjs");
export const FIXTURES = join(HERE, "..", "fixtures");

export function tmp(prefix = "ssg-check-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: opts.cwd || tmpdir(),
    encoding: "utf8",
    timeout: 30000,
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Build a fixture (or any dir) into a fresh output directory. */
export function build(src, extra = []) {
  const out = join(tmp(), "out");
  const r = run(["build", src, out, ...extra]);
  return { ...r, out };
}

export function fixture(name) {
  return join(FIXTURES, name);
}

/** Create a site from {relativePath: content}. */
export function makeSite(files) {
  const dir = tmp("ssg-site-");
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

export const LAYOUT = "<html><title>{{ title }}</title><body>{{ content }}</body></html>\n";

export function post(title, date, extra = "", body = "Body.\n") {
  return `---\ntitle: ${title}\ndate: ${date}\n${extra}---\n${body}`;
}

export function read(out, rel) {
  const p = join(out, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function norm(html) {
  return String(html ?? "").replace(/\s+/g, " ").replace(/\s*(<|>)\s*/g, "$1").trim();
}

/** Rendered Markdown body of a post page (normalised), from a layout that is just {{content}}. */
export function postBody(html) {
  const m = /<p class="meta">.*?<\/p>(?:<ul class="tags">.*?<\/ul>)?(.*)<\/article>/s.exec(norm(html));
  return m ? m[1] : null;
}

export function item(slug, title, date) {
  return `<li><a href="/posts/${slug}/">${title}</a> <time datetime="${date}">${date}</time></li>`;
}
