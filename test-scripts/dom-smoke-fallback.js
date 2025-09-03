#!/usr/bin/env node
/*
 * Lightweight DOM smoke test using jsdom as a fallback.
 * It fetches the page HTML and loads it into jsdom, then reports any script parse errors
 * Usage: node test-scripts/dom-smoke-fallback.js --url http://127.0.0.1:3003/inventory
 */
const argv = require('minimist')(process.argv.slice(2));
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');

const url = argv.url || process.env.BASE_URL || 'http://127.0.0.1:3003/';
const timeout = parseInt(argv.timeout || process.env.SMOKE_TIMEOUT || '10000', 10);

async function main() {
  console.log(`DOM fallback smoke test: fetching ${url}`);
  const res = await fetch(url, { timeout });
  if (!res.ok) {
    console.error('Failed to fetch page:', res.status, res.statusText);
    process.exit(2);
  }
  const html = await res.text();

  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url,
    virtualConsole: new (require('jsdom').VirtualConsole)().sendTo(console),
  });

  // Attach error listener
  dom.window.addEventListener('error', (e) => {
    errors.push(String(e.error || e.message || e));
  });

  // Wait a short while for scripts to run
  await new Promise((resolve) => setTimeout(resolve, 800));

  if (errors.length > 0) {
    console.error('Fallback DOM smoke detected errors:');
    errors.forEach((e, i) => console.error(`#${i + 1}:`, e));
    process.exit(2);
  }

  console.log('Fallback DOM smoke test PASSED (no errors captured).');
  process.exit(0);
}

main().catch(err => {
  console.error('Fallback DOM smoke failed:', err);
  process.exit(2);
});
