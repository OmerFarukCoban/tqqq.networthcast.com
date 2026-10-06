// With the static server running: node tests/tax-ui.cjs
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  try { ({ chromium } = require('/tmp/tax-browser/node_modules/playwright')); }
  catch {
    const root = require('node:child_process').execSync('npm root -g').toString().trim();
    ({ chromium } = require(require('node:path').join(root, 'playwright')));
  }
}
const BASE = process.env.BASE || 'http://localhost:8753';
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*googletagmanager*', route => route.abort());
    const ready = () => page.waitForSelector('#chart-legend .legend-chip', { timeout: 30000 });
    const values = () => page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('mainChart'));
      return [0, 2, 8].map(i => c.data.datasets[i].data.filter(v => typeof v === 'number').at(-1));
    });
    await page.goto(BASE); await ready();
    const off = await values();
    assert.equal(await page.getAttribute('#tax-toggle', 'aria-pressed'), 'false');
    await page.click('#tax-toggle');
    assert.equal(await page.getAttribute('#tax-toggle', 'aria-pressed'), 'true');
    assert.ok(await page.isVisible('#tax-assumptions'));
    const on = await values();
    assert.ok(on[0] < off[0], '9Sig should pay tax');
    assert.equal(on[1], off[1], 'B&H without sales should not pay capital-gains tax');
    assert.ok(on[2] < off[2], 'SMA should pay tax');
    assert.match(await page.textContent('#tax-summary'), /Cumulative tax paid/);
    await page.fill('#tax-fx', '32'); await page.locator('#tax-fx').blur();
    await page.fill('#tax-ppi-growth', '15'); await page.locator('#tax-ppi-growth').blur();
    assert.equal(await page.locator('#tax-fx-growth').count(), 0);
    assert.match(await page.textContent('#tax-usd-thresholds'), /\$5,938/);
    const changed = await values();
    await page.reload(); await ready();
    assert.equal(await page.inputValue('#tax-fx'), '32');
    assert.equal(await page.inputValue('#tax-ppi-growth'), '15');
    assert.equal(await page.getAttribute('#tax-toggle', 'aria-pressed'), 'true');
    assert.deepEqual(await values(), changed);
    // Use the real share serializer, capturing its clipboard output.
    const link = await page.evaluate(async () => {
      let output;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { output = text; } } });
      await shareConfig(); return output;
    });
    assert.equal(new URL(link).searchParams.get('trtax'), '1');
    await page.evaluate(() => localStorage.clear());
    await page.goto(link); await ready();
    assert.equal(await page.inputValue('#tax-fx'), '32');
    assert.deepEqual(await values(), changed);
    await page.click('#tax-toggle');
    assert.deepEqual(await values(), off, 'off must restore the original results exactly');
    // Old shared links must ignore tax-on preferences left in local storage.
    await page.click('#tax-toggle');
    const old = new URL(link);
    for (const key of ['trtax', 'trfx', 'trppi']) old.searchParams.delete(key);
    await page.goto(old.href); await ready();
    assert.equal(await page.getAttribute('#tax-toggle', 'aria-pressed'), 'false');
    // Small-screen control remains reachable and keyboard-operable.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.focus('#tax-toggle'); await page.keyboard.press('Space');
    assert.equal(await page.getAttribute('#tax-toggle', 'aria-pressed'), 'true');
    // Native library presets use the same global scenario as the reference runs.
    await page.evaluate(() => { addStrategyFromLibrary(42); addStrategyFromLibrary(43); });
    const savedValues = () => page.evaluate(() => Chart.getChart(document.getElementById('mainChart')).data.datasets
      .filter(d => d._configLine && !d._isShift && !d._configSubKey)
      .map(d => d.data.filter(v => typeof v === 'number').at(-1)));
    const savedOn = await savedValues();
    assert.ok(savedOn.length >= 2);
    await page.click('#tax-toggle');
    const savedOff = await savedValues();
    assert.ok(savedOff[0] > savedOn[0] && savedOff[1] > savedOn[1]);
    await page.click('#tax-toggle');
    assert.deepEqual(await savedValues(), savedOn);
    const nfciId = await page.evaluate(() => {
      addStrategyFromLibrary(44);
      return savedConfigs[savedConfigs.length - 1].id;
    });
    await page.waitForFunction(id => Object.hasOwn(window._customResults, id), nfciId, { timeout: 90000 });
    const nfciResult = await page.evaluate(id => window._customResults[id], nfciId);
    assert.equal(nfciResult.error, null);
    assert.ok(nfciResult.taxPayments?.length, 'NFCI strategy should return annual tax rows');
    assert.ok(nfciResult.log.some(r => ['sell', 'switch'].includes(r.action) && r.price > 0), 'sell rows should show their execution price');
    const nfciOn = await page.evaluate(id => {
      const d = Chart.getChart(document.getElementById('mainChart')).data.datasets.find(x => x._configId === id && !x._configSub);
      return { label: d.label, value: d.data.filter(v => typeof v === 'number').at(-1) };
    }, nfciId);
    assert.doesNotMatch(nfciOn.label, /pre-tax/);
    await page.evaluate(id => openCustomPanel(id), nfciId);
    await page.waitForSelector('.holding-pnl-year-table');
    const holdingTable = await page.textContent('.holding-pnl-year-table');
    assert.match(holdingTable, /TQQQ P\/L/); assert.match(holdingTable, /SQQQ P\/L/); assert.match(holdingTable, /Total P\/L/);
    await page.waitForSelector('.tax-year-table');
    const taxTable = await page.textContent('.tax-year-table');
    assert.match(taxTable, /Sale profit/); assert.match(taxTable, /Sale loss/); assert.match(taxTable, /Taxable/);
    assert.doesNotMatch(taxTable, /TRY/);
    await page.click('.strategy-panel-close');
    await page.click('#tax-toggle');
    await page.waitForFunction(id => !window._customResults[id] || window._customResults[id].taxPayments?.length === 0, nfciId);
    const nfciOff = await page.evaluate(id => {
      const d = Chart.getChart(document.getElementById('mainChart')).data.datasets.find(x => x._configId === id && !x._configSub);
      return d.data.filter(v => typeof v === 'number').at(-1);
    }, nfciId);
    assert.ok(nfciOff >= nfciOn.value);
    await page.evaluate(id => openCustomPanel(id), nfciId);
    await page.waitForSelector('.holding-pnl-year-table');
    assert.equal(await page.locator('.tax-year-table').count(), 0, 'holding P/L table should not depend on the tax scenario');
    await page.click('.strategy-panel-close');
    await page.click('#tax-toggle');
    await page.evaluate(() => addStrategyFromLibrary(1));
    await page.waitForFunction(() => Object.values(window._customResults).some(r => r.log?.length));
    assert.match(await page.textContent('#saved-configs'), /pre-tax/);
    assert.ok(await page.evaluate(() => Chart.getChart(document.getElementById('mainChart')).data.datasets.some(d => d.label.includes('(pre-tax)'))));
    assert.deepEqual(errors, []);
    console.log('Tax UI: recalculation, assumptions, persistence, sharing, old links, tax-off restoration and keyboard toggle passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
