#!/usr/bin/env node
/*
 * Generic DOM smoke test using Playwright.
 * Usage:
 *   node test-scripts/dom-smoke.js --url http://127.0.0.1:3003/inventory --timeout 15000
 * If Playwright is not installed, the script will print install instructions.
 */
const argv = require('minimist')(process.argv.slice(2));
const url = argv.url || process.env.BASE_URL || 'http://127.0.0.1:3003/';
const timeout = parseInt(argv.timeout || process.env.SMOKE_TIMEOUT || '15000', 10);

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    console.error('Playwright is not installed. To run this DOM smoke test, install it:');
    console.error('  npm install --save-dev playwright');
    console.error('Then run the script again.');
    process.exit(2);
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleMessages = [];
  const pageErrors = [];

  page.on('console', msg => {
    const entry = { type: msg.type(), text: msg.text() };
    consoleMessages.push(entry);
  });

  page.on('pageerror', err => {
    pageErrors.push(String(err));
  });

  console.log(`DOM smoke test: navigating to ${url} (timeout=${timeout}ms)`);
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout });
    console.log('HTTP status:', resp && resp.status());
  } catch (err) {
    console.error('Navigation failed:', err.message || err);
    await browser.close();
    process.exit(2);
  }

  // Wait a short time for any async scripts to run
  await page.waitForTimeout(500);

  // Evaluate basic DOM health
  const hasBody = await page.evaluate(() => !!document.body);
  if (!hasBody) {
    console.error('No <body> element found on the page.');
    await browser.close();
    process.exit(2);
  }

  // Report console errors and page errors
  const errors = consoleMessages.filter(m => m.type === 'error').map(m => m.text).concat(pageErrors);

  if (errors.length > 0) {
    console.error('DOM smoke test detected errors:');
    errors.forEach((e, i) => console.error(`#${i + 1}:`, e));
    console.log('\nFull console output:');
    consoleMessages.forEach((m, i) => console.log(`#${i + 1} [${m.type}]: ${m.text}`));
    await browser.close();
    process.exit(2);
  }

  console.log('No console errors or page errors detected. DOM smoke test PASSED.');
  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('DOM smoke test failed unexpectedly:', err);
  process.exit(2);
});
