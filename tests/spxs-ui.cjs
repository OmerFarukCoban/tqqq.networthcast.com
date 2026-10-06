// Start a static server, then run: node tests/spxs-ui.cjs (Playwright required).
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const BASE=process.env.BASE || 'http://localhost:8753';
(async()=>{
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage({viewport:{width:1500,height:950}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const ready=()=>page.waitForSelector('#chart-legend .legend-chip',{timeout:30000});
    await page.goto(BASE); await ready();
    await page.click('.legend-chip[data-idx="2"] .legend-more');
    await page.click('.pdrop:has(#select-bh-underlying) .pdrop-trigger');
    await page.click('.pdrop-popup .pdrop-row[data-value="spxs"]');
    const selected=await page.evaluate(()=>{
      const c=Chart.getChart('mainChart'), points=_logData.spxsPoints;
      return {name:c.data.datasets[2].label,chart:c.data.datasets[2].data.at(-1),expected:points.at(-1).value,
        price:points.at(-1).price,actual:daily.at(-1).spxs,
        options:['select-9sig-underlying','select-9sig-park-asset','select-sma-underlying',
          'select-sma-asset','select-sma-out-asset','select-sma-bg-asset'].every(id=>
          Array.from(document.getElementById(id).options).some(o=>o.value==='spxs'))};
    });
    assert.match(selected.name,/SPXS/); assert.equal(selected.chart,selected.expected);
    assert.equal(selected.price,selected.actual); assert(selected.chart>0 && selected.options);
    await page.evaluate(()=>saveConfigFromType('bh'));
    await page.reload(); await ready();
    assert.equal(await page.evaluate(()=>getSavedConfigs()[0].params['select-bh-underlying']),'spxs');
    assert(await page.evaluate(()=>{
      const cfg=getSavedConfigs()[0],c=Chart.getChart('mainChart');
      return c.data.datasets.find(d=>d._configId===cfg.id && d._configLine).data.filter(Number.isFinite).at(-1)>0;
    }));
    // App-native strategies must preserve SPXS when converted to saved configs.
    for(const type of ['9sig','sma']) {
      const saved=await page.evaluate(type=>{
        window._editingConfigId=null;
        document.getElementById('select-'+type+'-underlying').value='spxs';
        saveConfigFromType(type);
        const cfg=getSavedConfigs().at(-1),c=Chart.getChart('mainChart');
        return {asset:cfg.params['select-'+type+'-underlying'],value:c.data.datasets
          .find(d=>d._configId===cfg.id && d._configLine)?.data.filter(Number.isFinite).at(-1)};
      },type);
      assert.equal(saved.asset,'spxs'); assert(saved.value>0);
    }
    // Real Web Worker boundary, using the same custom-data channel as SQQQ.
    const custom=await page.evaluate(()=>new Promise((resolve,reject)=>{
      const url=URL.createObjectURL(new Blob(['('+customWorkerMain.toString()+')()'],{type:'text/javascript'}));
      const worker=new Worker(url);
      worker.onerror=e=>reject(new Error(e.message));
      worker.onmessage=e=>{worker.terminate();URL.revokeObjectURL(url);resolve(e.data);};
      worker.postMessage({type:'data',data:buildCustomData()});
      worker.postMessage({type:'run',reqId:1,code:'{run(data,p){const i=data.dates.length-1;return [{date:data.dates[i],value:data.spxs[i]}];}}'});
    }));
    assert.equal(custom.error,undefined); assert.equal(custom.log[0].value,selected.actual);
    // Share serialization must retain the new asset in both native and saved settings.
    const link = await page.evaluate(async () => {
      // Saving a strategy resets its native controls to the defaults.
      document.getElementById('select-bh-underlying').value = 'spxs';
      render();
      let output;
      Object.defineProperty(navigator, 'clipboard', {configurable:true,
        value:{writeText:async text=>{output=text;}}});
      await shareConfig();
      return output;
    });
    assert.equal(new URL(link).searchParams.get('bu'), 'spxs');
    await page.evaluate(()=>localStorage.clear());
    await page.goto(link); await ready();
    assert.equal(await page.inputValue('#select-bh-underlying'), 'spxs');
    assert(await page.evaluate(()=>getSavedConfigs().every(cfg=>
      cfg.params['select-'+cfg.type+'-underlying']==='spxs')));
    assert.equal(await page.evaluate(()=>STRATEGY_REGISTRY['bh-spxs'].pointsKey), 'spxsPoints');
    assert.deepEqual(errors,[]);
    console.log('SPXS UI: selectors, chart/price, saved B&H/9Sig/SMA, reload, sharing, analytics registration, and custom worker passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
