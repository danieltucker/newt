#!/usr/bin/env node
// Verify that the built CSS still says what the source said.
//
// ── Why this exists ──
// Every frosted surface in Newt - the shell bar, the bookmarks rail, the feed
// panel, the reading list, the newt button, the Explore stack - is a
// `backdrop-filter`. The source wrote each of them twice, standard property
// first and `-webkit-backdrop-filter` after, which is the habit everyone has
// from the years when Safari needed the prefix.
//
// Lightning CSS, which minifies the production build, understands the two as
// one property and collapses them. It keeps the last one it saw. So every rule
// written that way shipped as `-webkit-backdrop-filter` alone - and current
// Chromium and Firefox do not recognise that name at all: `CSS.supports` is
// false for it and the computed `backdrop-filter` is `none`. The frosting
// simply did not happen in production, on any browser, while dev looked
// perfect, because dev does not minify.
//
// The source no longer writes the prefix by hand; Lightning CSS adds it, and
// when it does, it emits both. This check is here because the failure is
// invisible: the build is green, the CSS is valid, the rule is present, and the
// only symptom is that a panel meant to be frosted glass is a sheet of
// cellophane.
//
//   node scripts/check-css.mjs
//
// Run `npm run build --workspace=client` first: this reads the built CSS,
// because that is what nginx serves.

import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'client', 'dist', 'assets');

let files;
try {
  files = readdirSync(assets).filter(f => f.endsWith('.css'));
} catch {
  console.error(`Could not read ${assets}\nRun: npm run build --workspace=client`);
  process.exit(2);
}

if (files.length === 0) {
  console.error(`No CSS in ${assets} - the build produced nothing to check.`);
  process.exit(2);
}

// Rule by rule, because "the file contains both names somewhere" is not the
// claim being made. Each rule that filters its backdrop has to name the
// property browsers actually implement.
const RULE = /([^{}]*)\{([^{}]*)\}/g;
const orphans = [];
let checked = 0;

for (const file of files) {
  const css = readFileSync(join(assets, file), 'utf8');
  for (const [, selector, body] of css.matchAll(RULE)) {
    const prefixed = /-webkit-backdrop-filter\s*:/.test(body);
    // The lookbehind keeps `-webkit-backdrop-filter` from matching as the
    // standard property: the character before it is a hyphen, not a boundary.
    const standard = /(?:^|[;{])\s*backdrop-filter\s*:/.test(body);
    if (prefixed || standard) checked++;
    if (prefixed && !standard) {
      orphans.push({ file, selector: selector.trim().slice(0, 80) });
    }
  }
}

if (orphans.length === 0) {
  console.log(`Built CSS OK: ${checked} backdrop-filter rules, all naming the standard property.`);
  process.exit(0);
}

console.error(
  'Built CSS has backdrop-filter rules that only name the -webkit- alias.\n' +
  'No current browser implements that name, so these surfaces will not be\n' +
  'frosted in production even though they are in dev.\n\n' +
  'Fix: delete the hand-written `-webkit-backdrop-filter` line from the source\n' +
  'rule. The minifier adds the prefix itself, and emits both when it does.\n',
);
for (const o of orphans) console.error(`  ${o.file}  ${o.selector}`);
process.exit(1);
