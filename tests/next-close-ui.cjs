// With a static server: node tests/next-close-ui.cjs (Playwright required).
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async()=>{
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage({viewport:{width:1500,height:950}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(process.env.BASE || 'http://localhost:8753');
    await page.waitForSelector('#chart-legend .legend-chip');
    await page.evaluate(()=>{
      const code=window.STRATEGY_CODE[44].replace(/    \{ id: "nextClose"[^\n]+\n/,'');
      savedConfigs.push({id:'timing_test',type:'custom',name:'Timing test',color:'#e879f9',hidden:false,code,params:{window:50}});
      persistSavedConfigs();render();
    });
    const settled=()=>page.waitForFunction(()=>{
      const cfg=getSavedConfigs().find(c=>c.id==='timing_test');
      const r=window._customResults.timing_test;
      return r && r.sig===customSig(cfg,window._customCtx);
    });
    await settled();await page.evaluate(()=>openCustomPanel('timing_test'));
    const toggle=page.locator('.cp-toggle[data-cp-id="nextClose"]');
    assert.equal(await toggle.getAttribute('aria-pressed'),'false');
    const before=await page.evaluate(()=>window._customResults.timing_test.log);
    await toggle.click();await settled();
    assert.equal(await toggle.getAttribute('aria-pressed'),'true');
    const after=await page.evaluate(()=>window._customResults.timing_test);
    assert.equal(after.error,null);assert.notDeepEqual(after.log,before);
    assert.equal(after.log[0].held,'CASH');
    assert(after.log.some(r=>/Signal \d{4}-/.test(r.note)));
    await page.reload();await page.waitForSelector('#chart-legend .legend-chip');await settled();
    await page.evaluate(()=>openCustomPanel('timing_test'));
    assert.equal(await toggle.getAttribute('aria-pressed'),'true');
    await toggle.click();await settled();
    assert.deepEqual(await page.evaluate(()=>window._customResults.timing_test.log),before);
    assert.deepEqual(errors,[]);
    console.log('Next-close UI: legacy saved copy, toggle, recalculation, reload persistence and exact restore passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
