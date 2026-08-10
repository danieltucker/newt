#!/usr/bin/env node
// Verify (or print) the CSP hash for the inline theme script in client/index.html.
//
// The Content-Security-Policy in client/security-headers.conf allows that one
// inline script by the sha256 of its exact contents, so any edit to it — even
// whitespace — invalidates the hash. The failure is quiet: the browser refuses to
// run the script and logs a CSP violation, the app still loads, and the only
// symptom is a flash of the wrong theme on first paint. Easy to ship without
// noticing, which is why this is a script you can wire into CI rather than a note
// in a comment.
//
// The policy used to live inline in nginx.conf and moved into an include when a
// second location — the server-rendered document routes — needed the same
// headers. Both files are searched rather than just the new one, so a deployment
// that still carries the old shape is reported as OK rather than as a mismatch.
//
//   node scripts/csp-hash.mjs          # verify dist against the nginx config
//   node scripts/csp-hash.mjs --print  # just print the hash
//
// Run `npm run build --workspace=client` first: this reads the *built* HTML, since
// that is what nginx actually serves.

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distHtml = join(root, 'client', 'dist', 'index.html');
// Where the policy may live. Order is preference, not precedence — the hash only
// has to appear in one of them.
const policyFiles = [
  join(root, 'client', 'security-headers.conf'),
  join(root, 'client', 'nginx.conf'),
];

let html;
try {
  html = readFileSync(distHtml, 'utf8');
} catch {
  console.error(`Could not read ${distHtml}\nRun: npm run build --workspace=client`);
  process.exit(2);
}

// Strip comments before matching. Without this the search trips over the literal
// "<script" that appears inside the explanatory comment in index.html.
const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
const inline = [...stripped.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];

if (inline.length !== 1) {
  console.error(
    `Expected exactly 1 inline <script> in the built HTML, found ${inline.length}.\n` +
    `If you added one deliberately, add its hash to script-src in\n` +
    `client/security-headers.conf too.`,
  );
  process.exit(1);
}

const hash = 'sha256-' + createHash('sha256').update(inline[0][1], 'utf8').digest('base64');

if (process.argv.includes('--print')) {
  console.log(hash);
  process.exit(0);
}

const found = policyFiles.find(file => {
  try {
    return readFileSync(file, 'utf8').includes(hash);
  } catch {
    // A missing file is not a failure: only one of these has to exist.
    return false;
  }
});

if (found) {
  console.log(`CSP hash OK: ${hash}`);
  process.exit(0);
}

console.error(
  `CSP hash MISMATCH.\n` +
  `  built index.html needs: ${hash}\n` +
  `  neither client/security-headers.conf nor client/nginx.conf contains it.\n\n` +
  `Paste that value into the script-src directive in client/security-headers.conf.`,
);
process.exit(1);
