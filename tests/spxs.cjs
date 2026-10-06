// Offline data/engine integration: node tests/spxs.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const ctx = vm.createContext({console, fmt: String, computeMaxDrawdown: () => ({pct: 0})});
const run = code => vm.runInContext(code, ctx);
for (const file of ['data.js','simulate.js','metrics.js']) run(fs.readFileSync(path.join(root,'js',file),'utf8'));
ctx.series = ['qqq','tqqq','spy','qld','sso','spxl','sqqq','udow','eurl','spxs'].map(asset => {
  ctx.text = fs.readFileSync(path.join(root,'data',asset==='spy'?'spy.tsv':`synthetic-${asset}.tsv`),'utf8');
  return run('parseDataFile(text)');
});
const spxs = ctx.series.at(-1);
assert.equal(spxs[0][0], '1953-01-02');
assert(spxs.every(([date,p],i) => Number.isFinite(p) && p>0 && (!i || date>spxs[i-1][0])));
run(`daily=buildDaily(...series); quarterlyData=buildPeriodData(getQuarter); monthlyData=buildPeriodData(getMonth);
  dailyDateToIdx=new Map(daily.map((d,i)=>[d.date,i]));
  precomputePeriodSeries(); precomputeMonthlyByQuarter(); precomputeSMASeries();`);
assert(run('daily.every(d=>d.spxs>0)'));
assert(run(`[dailyRows,monthlyData,quarterlyData,weeklyData,yearlyData,
  buildExactRangeQData('quarterly','2010-03-31','2011-03-31'),
  buildEnvelopeQData('quarterly',20,'2010-03-31','2011-03-31')].every(rows=>
    rows.every(r=>r[10]===daily[dailyDateToIdx.get(r[0])].spxs && r[7]===daily[dailyDateToIdx.get(r[0])].sqqq))`));
assert.equal(run('SMA_UNLEVERAGED_OF.spxs'), 'spy');
assert(run('smaAtDailyByKey.spxs_200.at(-1)>0 && rsiAtDailyByKey.spxs_10.at(-1)>=0'));
assert.equal(run(`buildCustomDDControls([{date:'2020-01-01',held:'SPXS',shares:3,cash:4}])[0].h.spxs`), 3);
// Known-return fixture: all old assets stay flat; SPXS alone doubles.
run(`monthlyData=Array.from({length:12},(_,i)=>['2020-'+String(i+1).padStart(2,'0')+'-28',100,100,100,100,100,100,100,100,100,i<3?100:200]);
  quarterlyData=monthlyData.filter((_,i)=>i%3===2);
  periodDataByName=null; monthsInPeriodByName=null; monthlyByQuarter=null;
  smaAtMonthlyByKey={spy_2:monthlyData.map(()=>50)};`);
assert.equal(run(`simulate(1000,0,0,0,3,0,{}).spxsPoints.at(-1).value`), 2000);
assert.equal(run(`simulate(1000,0,0,0,3,0,{}).sqqqPoints.at(-1).value`), 1000);
assert.equal(run(`simulate(1000,0,0,0,3,0,{underlyingCol:10,cashPct:0}).log.at(-1).total`), 2000);
assert.equal(run(`simulate(1000,0,0,0,3,0,{parkAsset:'spxs',cashPct:1}).log.at(-1).total`), 2000);
assert.equal(run(`simulateSMA(1000,0,0,0,3,0,{smaAsset:'spy',smaWindow:2,underlyingCol:10}).smaPoints.at(-1).value`), 2000);
run('smaAtMonthlyByKey.spy_2=monthlyData.map(()=>150)');
assert.equal(run(`simulateSMA(1000,0,0,0,3,0,{smaAsset:'spy',smaWindow:2,outAsset:'spxs'}).smaPoints.at(-1).value`), 2000);
console.log('SPXS: complete coverage, period columns, indicators, drawdown, B&H, 9Sig, SMA, and hedge holdings passed.');
