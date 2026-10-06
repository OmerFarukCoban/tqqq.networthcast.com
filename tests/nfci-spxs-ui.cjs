// With a static server: node tests/nfci-spxs-ui.cjs (Playwright required).
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8753';

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ready = () => page.waitForSelector('#chart-legend .legend-chip');
    const settled = id => page.waitForFunction(id => {
      const cfg = getSavedConfigs().find(c => c.id === id);
      const result = window._customResults[id];
      return cfg && result && result.sig === customSig(cfg, window._customCtx);
    }, id);
    await page.goto(BASE); await ready();
    // Reproduce a saved copy from before the S&P options were introduced.
    // Keep its tax-aware implementation: the old tax migration must not hide the bug.
    const legacyCode = await page.evaluate(() => {
      const code = window.STRATEGY_CODE[44]
        .replace(/\{ value: "spxs", label: "SPXS" \}, /g, '')
        .replace(/\{ value: "spxl", label: "SPXL" \}, /g, '');
      savedConfigs.push({ id: 'nfci_legacy', type: 'custom', name: 'My NFCI comparison',
        color: '#e879f9', hidden: false, code,
        params: { asset: 'tqqq', park: 'sqqq', crashAsset: 'cash', window: 50, overPct: 20 } });
      persistSavedConfigs();
      return code;
    });
    assert(legacyCode.includes('taxPayments: tax ? tax.payments : []'));
    assert(!legacyCode.includes('value: "spxs"'));
    await page.reload(); await ready(); await settled('nfci_legacy');
    assert.equal(await page.evaluate(() => window._customResults.nfci_legacy.error), null);
    assert.deepEqual(await page.evaluate(() => getSavedConfigs()[0].params),
      { asset: 'tqqq', park: 'sqqq', crashAsset: 'cash', window: 50, overPct: 20 });
    await page.evaluate(() => openCustomPanel('nfci_legacy'));
    const choose = async (id, label) => {
      await page.click(`.cp-trigger[data-cp-id="${id}"]`);
      await page.locator('.pdrop-popup .pdrop-row').filter({
        has: page.locator('.pdrop-rlabel', { hasText: new RegExp('^' + label + '$') })
      }).click();
      await settled('nfci_legacy');
    };
    await choose('asset', 'SPXL');
    await page.click('.cp-trigger[data-cp-id="park"]');
    const spxsRow = page.locator('.pdrop-popup .pdrop-row').filter({
      has: page.locator('.pdrop-rlabel', { hasText: /^SPXS$/ })
    });
    await spxsRow.locator('.pdrop-rval').filter({ hasNotText: '…' }).waitFor();
    await spxsRow.click(); await settled('nfci_legacy');
    await choose('crashAsset', 'SPXS');
    await choose('crashAsset', 'Cash');
    const result = await page.evaluate(() => window._customResults.nfci_legacy);
    assert.equal(result.error, null);
    assert(result.log.some(r => r.held === 'SPXL'));
    assert(result.log.some(r => r.held === 'SPXS'));
    assert(!result.log.some(r => r.held === 'TQQQ' || r.held === 'SQQQ'));
    assert(result.log.every(r => Number.isFinite(r.value) && r.value >= 0));
    assert.equal(await page.evaluate(() => getSavedConfigs()[0].code), legacyCode);
    // Persist and share the chosen pair without overwriting the saved source.
    await page.reload(); await ready(); await settled('nfci_legacy');
    const params = await page.evaluate(() => getSavedConfigs()[0].params);
    assert.equal(params.asset, 'spxl'); assert.equal(params.park, 'spxs');
    assert.equal(params.crashAsset, 'cash'); assert.equal(params.overPct, 20);
    const link = await page.evaluate(async () => {
      let output;
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { output = text; } } });
      await shareConfig(); return output;
    });
    await page.evaluate(() => localStorage.clear());
    await page.goto(link); await ready();
    const shared = await page.evaluate(() => getSavedConfigs()[0]);
    await settled(shared.id);
    assert.deepEqual(shared.params, params);
    assert.equal(shared.code, legacyCode);
    assert.equal(await page.evaluate(id => window._customResults[id].error, shared.id), null);
    const options = await page.evaluate(id => getCustomSchema(getSavedConfigs().find(c => c.id === id))
      .filter(sp => sp.id === 'park' || sp.id === 'crashAsset')
      .map(sp => sp.options.filter(o => o.value === 'spxs').length), shared.id);
    assert.deepEqual(options, [1, 1]);
    // A fresh library copy already has SPXS; do not duplicate its options.
    const freshId = await page.evaluate(() => {
      addStrategyFromLibrary(44);
      return getSavedConfigs().at(-1).id;
    });
    await settled(freshId);
    assert.equal(await page.evaluate(id => getCustomSchema(getSavedConfigs().find(c => c.id === id))
      .find(sp => sp.id === 'park').options.filter(o => o.value === 'spxs').length, freshId), 1);
    assert.deepEqual(errors, []);
    console.log('NFCI: saved and new options, SPXL/SPXS holdings, previews, preserved code/settings, reload and sharing passed.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
