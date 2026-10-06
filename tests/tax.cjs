// Hand-calculated tax and simulation regressions: node tests/tax.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({ console, Map, Set, Date, fmt: String });
for (const name of ['tax', 'simulate']) vm.runInContext(fs.readFileSync(`${__dirname}/../js/${name}.js`, 'utf8'), ctx);
const run = code => vm.runInContext(code, ctx);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${a} != ${b}`);
run('globalThis.Ledger = TurkeyTaxLedger');
const ledger = settings => new ctx.Ledger({ enabled: true, fx: 1, ...settings }, '2024-01-01');

for (const [income, expected] of [[-1, 0], [0, 0], [190000, 28500], [400000, 70500], [1000000, 232500], [5300000, 1737500], [5400000, 1777500]]) {
  close(ctx.turkeyIncomeTax(income), expected);
}
close(ctx.turkeyIncomeTax(190000 / 40, 40), 28500 / 40);
// FIFO, partial lots, fees included in basis and net proceeds.
let t = ledger();
t.buy('a', 10, 1010, '2024-01-01'); t.buy('a', 10, 2000, '2024-02-01');
t.sell('a', 12, 2970, '2024-03-01'); close(t.gains, 1560);
t.sell('a', 8, 1600, '2024-04-01'); close(t.gains, 1560);
close(t.realizedProfit, 1560); close(t.realizedLoss, 0);
assert.throws(() => t.sell('a', 1, 100, '2024-04-01'), /exceeds/);
// The threshold is inclusive for indexing, exclusive for declaring interest.
for (const [ratio, gain] of [[1.099, 500], [1.1, 400], [1.5, 0]]) {
  t = ledger({ ppiAt: month => month === 2023 * 12 + 11 ? 100 : 100 * ratio });
  t.buy('a', 10, 1000, '2024-01-01'); t.sell('a', 10, 1500, '2024-02-01'); close(t.gains, gain);
}
t = ledger({ ppiGrowth: .1 });
close(t.ppi('2025-01-29') / t.ppi('2024-01-01'), 1.1);
close(t.ppi('2024-01-29'), t.ppi('2024-01-01'));
t = ledger(); t.addInterest(22000, '2024-01-01'); close(t.due(), 0);
t.addInterest(1, '2024-02-01'); close(t.due(), 22001 * .15);
t = ledger({ fx: 40 }); t.addInterest(550, '2024-01-01'); close(t.due(), 0);
t.addInterest(1, '2024-02-01'); close(t.due(), 551 * .15);
t.gains = -99999; close(t.due(), 551 * .15); // capital loss cannot erase interest
t.settle('2024-12-31', 100000); t.gains = 100; close(t.due(), 15); // no loss carry

// Pay from cash first; a tax-funding sale realizes additional taxable gain.
t = ledger(); t.buy('a', 10, 1000, '2024-01-01'); t.gains = 1000;
let quantity = 10;
const remaining = t.settle('2024-12-31', 0, need => {
  const sold = Math.min(quantity, need / 200);
  t.sell('a', sold, sold * 200, '2024-12-31'); quantity -= sold; return sold * 200;
});
close(t.payments[0].taxUSD, 150 / (1 - .15 * .5)); close(remaining, 0);
close(quantity * 200, 2000 - t.payments[0].taxUSD);
t = ledger(); t.gains = 1000;
close(t.settle('2024-12-31', 1000, () => { throw Error('cash should cover tax'); }), 850);
// Losses on forced sales reduce the eventual bill; any excess stays as cash.
t = ledger(); t.buy('a', 10, 2000, '2024-01-01'); t.gains = 1000;
close(t.settle('2024-12-31', 0, need => { t.sell('a', need / 100, need, '2024-12-31'); return need; }), 22.5);
close(t.payments[0].taxUSD, 127.5);

run(`
  globalThis.monthlyData = Array.from({length: 24}, (_, i) => {
    const date = new Date(Date.UTC(2024 + Math.floor(i / 12), i % 12 + 1, 0)).toISOString().slice(0, 10);
    const price = i <= 2 ? 100 : 200;
    return [date, price, price, price, price, price, price, price];
  });
  globalThis.quarterlyData = monthlyData.filter(r => ['03','06','09','12'].includes(r[0].slice(5,7)));
  globalThis.periodDataByName = null; globalThis.monthsInPeriodByName = null; globalThis.monthlyByQuarter = null;
  globalThis.smaAtMonthlyByKey = { qqq_200: monthlyData.map((_,i) => i < 5 ? 1 : 10000) };
  globalThis.rsiAtMonthlyByAsset = null;
  globalThis.taxOpts = { tax: { enabled: true, fx: 1 }, qGrowth: 0, spikeTriggerPct: 0 };
`);
let result = run('simulate(1000, 0, 0, 0, 7, 0, taxOpts)');
close(result.taxPayments[0].taxUSD, 45);
close(result.log.at(-1).total, 1555);
close(result.bhPoints.at(-1).value, 2000); // no sale, no tax on unrealized gains
assert.equal(result.taxPayments[0].date, '2024-12-31');
assert.equal(result.taxPayments.length, 2);
close(result.taxPayments[1].taxUSD, 0);
close(run('simulate(1000, 0, 0, 0, 1, 0, taxOpts)').log.at(-1).total, 1555); // partial-year exit
result = run('simulate(1000, 0, 0, 0, 7, 0, {...taxOpts, tax: {enabled: false}})');
close(result.log.at(-1).total, 1600); assert.equal(result.taxPayments.length, 0);
result = run('simulateSMA(1000, 0, 0, 0, 7, 0, taxOpts)');
close(result.taxPayments[0].taxUSD, 150); close(result.smaPoints.at(-1).value, 1850);
assert.ok(result.smaLog.some(r => r.action === 'TAX' && Math.abs(r.tax - 150) < 1e-6));
result = run('simulateSMA(1000, 0, 0, 0, 7, 0, {...taxOpts, tradeCostPct: 1})');
close(result.taxPayments[0].taxUSD, 144.03); close(result.smaPoints.at(-1).value, 1816.17);
// Both sleeves in one asset share FIFO lots, including tax funding sales.
for (const parkAsset of ['cash', 'qqq', 'tqqq']) {
  ctx.parkAsset = parkAsset;
  result = run('simulate(1000, 10, .04, 0, 7, 0, {...taxOpts, parkAsset, tradeCostPct: .2})');
  assert.ok(result.log.every(r => Number.isFinite(r.total) && Math.abs(r.total - r.tqqqVal - r.cash) < 1e-6));
}
// Tax must be paid in December even if a yearly rebalance falls in March.
result = run('simulate(1000000, 0, .12, 0, 7, 0, {...taxOpts, rebalancePeriod: "yearly", sampleQuarterly: true})');
assert.equal(result.taxPayments[0].date, '2024-12-31');
assert.ok(result.taxPayments[0].taxUSD > 0);
assert.ok(result.baselineTaxPayments[0].taxUSD > 0);
const december = result.samplePoints.find(r => r.date === '2024-12-31');
assert.ok(december && december.investedCompounded < 1000000 * Math.pow(1.01, 9));
// Withdrawals sell B&H lots and incur tax; contributions do not.
result = run(`simulate(1000, 0, 0, 0, 7, 0, {...taxOpts, schedule: {
  byMonth: new Map([['2024-06', -200]]), byDate: new Map(), list: []
}})`);
close(result.bhTaxPayments.tqqq[0].gainsUSD, 100 + result.bhTaxPayments.tqqq[0].taxUSD * .5);
close(result.bhPoints.at(-1).value, 1800 - 15 / .925);
// A weekly strategy must not restart its progressive brackets every December week.
result = run(`simulate(1000, 0, 0, 0, 7, 0, {...taxOpts,
  entryDateOverride: '2024-11-30', exitDateOverride: '2025-03-31',
  qData: ['2024-11-30','2024-12-06','2024-12-13','2024-12-20','2024-12-31','2025-03-31']
    .map((d,i) => [d, 200+i*20, 200, 200, 200, 200, 200, 200])
})`);
assert.deepEqual(Array.from(result.taxPayments, r => r.date), ['2024-12-31', '2025-03-31']);

// The NFCI/SQQQ library strategy records its own sales and pays from the
// portfolio at each year end while leaving unsold positions unrealized.
ctx.nfciCode = require('../js/strategy-library-code.js')[44];
run(`
  globalThis.nfciMod = eval('(' + nfciCode + ')');
  globalThis.nfciData = {
    dates: ['2024-12-20','2024-12-23','2024-12-24','2024-12-26','2024-12-27','2024-12-30','2024-12-31','2025-01-02','2025-01-03'],
    tqqq: [100,100,100,200,200,200,200,200,200],
    sqqq: [100,100,100,100,100,100,100,100,100],
    nfci: [0,0,0,0,0,0,0,0,0]
  };
  globalThis.nfciParams = {
    initial: 1000, contributions: {}, startIdx: 0, endIdx: 8,
    asset: 'tqqq', stat: 'median', window: 2, overPct: 20, park: 'sqqq',
    crashStat: 'same', crashWindow: 0, exitPct: -90, crashAsset: 'cash',
    slopeGate: 999, belowGate: 0, nfciTh: 999, vetoEnd: 'cycle',
    splitDays: true, cashRate: 0, tradeCost: 0,
    tax: { enabled: true, fx: 1, ppiGrowth: 0 }
  };
`);
const nfciTaxed = run('nfciMod.run(nfciData, nfciParams)');
const nfciUntaxed = run('nfciMod.run(nfciData, {...nfciParams, tax: {enabled:false}})');
assert.equal(nfciTaxed.taxPayments[0].date, '2024-12-31');
close(nfciTaxed.taxPayments[0].profitUSD, 1000);
close(nfciTaxed.taxPayments[0].lossUSD, 0);
close(nfciTaxed.taxPayments[0].taxableIncomeUSD, 1000);
close(nfciTaxed.taxPayments[0].taxUSD, 150);
assert.equal(Array.from(nfciTaxed.annualHoldingPnl, r => r.year).join(','), '2024,2025');
close(nfciTaxed.annualHoldingPnl[0].tqqq, 1000);
close(nfciTaxed.annualHoldingPnl[0].sqqq, 0);
close(nfciTaxed.annualHoldingPnl[0].total, 1000);
close(nfciTaxed.log.at(-1).value, nfciUntaxed.log.at(-1).value - 150);
const nfciSell = nfciTaxed.log.find(r => r.action === 'sell');
assert.ok(nfciSell && nfciSell.price === 200, 'NFCI sell row should retain its execution price');
assert.equal(nfciUntaxed.taxPayments.length, 0);

console.log('USD tax brackets, FIFO, indexing, interest, funding sales, annual settlement, NFCI/SQQQ sell prices, SMA, 9Sig, B&H and tax-off regressions passed.');
