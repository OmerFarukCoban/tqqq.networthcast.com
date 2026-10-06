// Offline market-data integration checks: node tests/market-data.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const ctx = vm.createContext({console, fmt: String, computeMaxDrawdown: () => ({pct: 0})});
const run = code => vm.runInContext(code, ctx);
for (const file of ['data.js', 'simulate.js']) run(fs.readFileSync(path.join(root, 'js', file), 'utf8'));
const names = ['qqq', 'tqqq', 'spy', 'qld', 'sso', 'spxl', 'sqqq', 'udow', 'eurl'];
ctx.series = names.map(name => {
  ctx.text = fs.readFileSync(path.join(root, 'data', name === 'spy' ? 'spy.tsv' : `synthetic-${name}.tsv`), 'utf8');
  const rows = run('parseDataFile(text)');
  assert(rows.every(([date, value], i) => Number.isFinite(value) && value > 0 && (!i || date > rows[i-1][0])), name);
  return rows;
});
run(`daily = buildDaily(...series);
quarterlyData = lastOfPeriod(daily, getQuarter).map(d => [d.date,d.tqqq,d.qqq,d.spy,d.qld,d.sso,d.spxl,d.sqqq,d.udow,d.eurl]);
monthlyData = buildPeriodData(getMonth);
dailyDateToIdx = new Map(daily.map((d,i) => [d.date,i]));
precomputePeriodSeries(); precomputeMonthlyByQuarter(); precomputeSMASeries();`);
for (const [asset, col, first] of [['udow', 8, '1992-01-02'], ['eurl', 9, '1990-06-18']]) {
  assert.equal(run(`daily.find(d => d.${asset} > 0).date`), first);
  assert(run(`daily.filter(d => d.date < '${first}').every(d => d.${asset} === 0)`));
  assert(run(`daily.filter(d => d.date >= '${first}').every(d => d.${asset} > 0)`));
  assert(run(`[monthlyData, quarterlyData, weeklyData, yearlyData, dailyRows,
    buildExactRangeQData('quarterly', '2010-03-31', '2011-03-31'),
    buildEnvelopeQData('quarterly', 20, '2010-03-31', '2011-03-31')]
    .every(rows => rows.every(row => row[${col}] === daily[dailyDateToIdx.get(row[0])].${asset}))`));
  const ratio = run(`(() => {
    const e = quarterlyData.findIndex(r => r[0] === '2010-03-31');
    const x = quarterlyData.findIndex(r => r[0] === '2011-03-31');
    const r = simulate(1000, 0, 0, e, x, 0, { underlyingCol: ${col} });
    return [r.${asset}Points.at(-1).value, 1000 * quarterlyData[x][${col}] / quarterlyData[e][${col}]];
  })()`);
  assert(Math.abs(ratio[0] - ratio[1]) < 1e-8, `${asset} buy-and-hold must use its own returns`);
  assert.equal(run(`simulate(1000,0,0,0,10,0,{underlyingCol:${col}}).log.length`), 0);
  assert.equal(run(`simulate(1000,0,0,0,10,0,{}).${asset}Points.length`), 0);
}
// A leading missing-price prefix must not influence Wilder's RSI seed.
assert.equal(JSON.stringify(run('rollingRSI([0,0,10,12,11,13],2).slice(2)')),
             JSON.stringify(run('rollingRSI([10,12,11,13],2)')));
assert.equal(JSON.stringify(run('rollingSMA([0,0,10,12,11],2)')), '[null,null,null,11,11.5]');
// Known-price scenario: legacy assets stay flat; each new ETF doubles.
run(`monthlyData = Array.from({length:12}, (_,i) => ['2020-'+String(i+1).padStart(2,'0')+'-28',100,100,100,100,100,100,100,i<3?100:200,i<3?100:200]);
quarterlyData = monthlyData.filter((_,i) => i%3===2);
periodDataByName = null; monthsInPeriodByName = null; monthlyByQuarter = null;
smaAtMonthlyByKey = {qqq_2: monthlyData.map(() => 50)};`);
for (const [asset, col] of [['udow',8],['eurl',9]]) {
  assert.equal(run(`simulateSMA(1000,0,0,0,3,0,{smaAsset:'qqq',smaWindow:2,underlyingCol:${col}}).smaPoints.at(-1).value`), 2000);
  assert.equal(run(`simulate(1000,0,0,0,3,0,{underlyingCol:${col},cashPct:0}).log.at(-1).total`), 2000);
  assert.equal(run(`simulate(1000,0,0,0,3,0,{parkAsset:'${asset}',cashPct:1}).log.at(-1).total`), 2000);
}
console.log('Market data: coverage, date joins, all period rows, SMA/RSI, new-asset returns and missing-history guards passed.');
