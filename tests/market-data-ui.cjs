// With a static server: node tests/market-data-ui.cjs (requires Playwright).
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8753';
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport: {width: 1500, height: 950}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ready = () => page.waitForSelector('#chart-legend .legend-chip', {timeout:30000});
    await page.goto(BASE); await ready();
    await page.click('.legend-chip[data-idx="2"] .legend-more');
    for (const asset of ['udow','eurl']) {
      await page.click('.pdrop:has(#select-bh-underlying) .pdrop-trigger');
      await page.click(`.pdrop-popup .pdrop-row[data-value="${asset}"]`);
      const result = await page.evaluate(asset => {
        const c = Chart.getChart('mainChart');
        const points = _logData[asset+'Points'];
        return {name: c.data.datasets[2].label, chart: c.data.datasets[2].data.at(-1),
          expected: points.at(-1).value, price: points.at(-1).price, actualPrice: daily.at(-1)[asset],
          options: ['select-9sig-underlying','select-9sig-park-asset','select-sma-underlying',
            'select-sma-asset','select-sma-out-asset','select-sma-bg-asset'].every(id =>
              Array.from(document.getElementById(id).options).some(o => o.value === asset))};
      }, asset);
      assert.match(result.name, new RegExp(asset.toUpperCase()));
      assert.equal(result.chart, result.expected);
      assert.equal(result.price, result.actualPrice);
      assert(result.chart > 0 && result.options);
    }
    // Save/reload must preserve the new ticker and its chart, not fall back to TQQQ.
    await page.evaluate(() => saveConfigFromType('bh'));
    await page.reload(); await ready();
    assert.equal(await page.evaluate(() => getSavedConfigs()[0].params['select-bh-underlying']), 'eurl');
    const saved = await page.evaluate(() => {
      const cfg = getSavedConfigs()[0], c = Chart.getChart('mainChart');
      const line = c.data.datasets.find(d => d._configId === cfg.id && d._configLine);
      return line.data.filter(v => Number.isFinite(v)).at(-1);
    });
    assert(saved > 0);
    // An early saved/shared date must move forward to the available history.
    const clamped = await page.evaluate(() => {
      document.getElementById('slider-entry').value = 0;
      document.getElementById('entry-exact-date').value = '1980-01-02';
      render();
      const i = +document.getElementById('slider-entry').value;
      return {date: quarterlyData[i-1][0], override: document.getElementById('entry-exact-date').value,
        valid: Chart.getChart('mainChart').data.datasets.filter(d => d._configLine)
          .every(d => d.data.every(v => v == null || Number.isFinite(v)))};
    });
    assert(clamped.date >= '1990-06-18' && clamped.valid);
    assert.equal(clamped.override, '');
    // Custom code receives both funds across the real Web Worker boundary.
    const custom = await page.evaluate(() => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob(['('+customWorkerMain.toString()+')()'], {type:'text/javascript'}));
      const worker = new Worker(url);
      worker.onerror = e => reject(new Error(e.message));
      worker.onmessage = e => { worker.terminate(); URL.revokeObjectURL(url); resolve(e.data); };
      worker.postMessage({type:'data', data:buildCustomData()});
      worker.postMessage({type:'run', reqId:1, code:'{run(data,p){const i=data.dates.length-1; return [{date:data.dates[i],value:data.udow[i]+data.eurl[i]}];}}'});
    }));
    assert.equal(custom.error, undefined);
    assert(custom.log[0].value > 0);
    assert.deepEqual(errors, []);
    console.log('Market-data UI: selectors, prices, chart, saved/reloaded EURL, date floor and custom worker passed.');
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exit(1);});
