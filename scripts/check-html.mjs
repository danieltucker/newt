#!/usr/bin/env node
// Verify that the built index.html actually loads the application.
//
// ── Why this exists ──
// Vite injects the entry script and the stylesheet immediately before the first
// regex match for the closing head tag in client/index.html. It does not parse
// the document first, so it cannot tell that the match it found is inside an
// HTML comment. v1.15.0 added a comment that spelled that tag out in prose, and
// the build duly injected both tags into the middle of it.
//
// What shipped was a document with a correct <head>, a correct <div id="root">,
// no stylesheet, and no application - a blank page on every route. Nothing
// caught it: tsc passed, 414 client tests passed, the CSP hash still verified
// (the inline script it hashes was untouched), the build printed asset sizes for
// files nothing referenced, and the HTML was valid. The only way to see it was
// to read the built markup or load the site.
//
// So the check is deliberately dumb and end-of-pipeline: strip the comments,
// and see whether the tags that boot the app survive. Anything that swallows
// them - this bug, a stray unclosed comment, a plugin injecting to the wrong
// place - fails here rather than in production.
//
//   node scripts/check-html.mjs
//
// Run `npm run build --workspace=client` first: this reads the built HTML,
// because that is what nginx serves.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distHtml = join(root, 'client', 'dist', 'index.html');

let html;
try {
  html = readFileSync(distHtml, 'utf8');
} catch {
  console.error(`Could not read ${distHtml}\nRun: npm run build --workspace=client`);
  process.exit(2);
}

// The same technique csp-hash.mjs uses, for the same reason: what a browser
// ignores, this has to ignore too. A tag that only exists inside a comment does
// not exist.
const live = html.replace(/<!--[\s\S]*?-->/g, '');

const checks = [
  {
    name: 'entry script',
    // Vite emits `<script type="module" crossorigin src="/assets/index-HASH.js">`.
    // Matched loosely on purpose - the attribute order and the `crossorigin`
    // are Vite's business and have changed between versions. What this file
    // cares about is that a module script pointing into /assets/ is reachable.
    re: /<script[^>]*\btype=["']module["'][^>]*\bsrc=["']\/assets\/[^"']+\.js["']/i,
    hint: 'nothing boots the app: no module <script> pointing at /assets/.',
  },
  {
    name: 'stylesheet',
    re: /<link[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']\/assets\/[^"']+\.css["']/i,
    hint: 'the app would load unstyled: no <link rel="stylesheet"> for /assets/.',
  },
  {
    name: 'mount point',
    re: /<div[^>]*\bid=["']root["']/i,
    hint: 'React has nothing to mount into: no <div id="root">.',
  },
];

const failed = checks.filter(c => !c.re.test(live));

if (failed.length === 0) {
  console.log('Built HTML OK: entry script, stylesheet and #root are all live.');
  process.exit(0);
}

console.error('Built index.html is missing something load-bearing:\n');
for (const f of failed) {
  // The distinction that matters: present-but-commented is a very different
  // bug from absent, and it is the one that actually happened.
  const commentedOut = f.re.test(html);
  console.error(`  ✗ ${f.name} - ${f.hint}`);
  if (commentedOut) {
    console.error(
      '    It IS in the file, but inside an HTML comment, so the browser\n' +
      '    never sees it. Vite injects before the first match for the closing\n' +
      '    head tag; check client/index.html for a comment that names that tag\n' +
      '    in prose. See the note in that file.',
    );
  }
}
console.error(`\nRead: ${distHtml}`);
process.exit(1);
