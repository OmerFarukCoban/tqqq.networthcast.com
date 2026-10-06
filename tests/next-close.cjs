// Deterministic execution timing and unchanged same-close regressions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = require('../js/strategy-library-code.js')[44];
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync('js/tax.js', 'utf8'), ctx);
const strategy = vm.runInContext('(' + code + ')', ctx);
const defaults = Object.fromEntries(strategy.params.filter(p => p.id).map(p => [p.id, p.default]));
const dates = ['2024-01-04','2024-01-05','2024-01-08','2024-01-09','2024-01-10','2024-01-11','2024-01-12'];
const base = { ...defaults, initial: 1000, startIdx: 0, endIdx: 6, window: 2,
  overPct: 20, exitPct: -20, slopeGate: 999, belowGate: 0,
  nfciTh: .4, vetoEnd: 'nfci', cashRate: 0, tradeCost: 0, splitDays: false };
const data = { dates, tqqq: [100,100,200,180,50,100,300],
  sqqq: [100,110,120,130,140,150,160], nfci: [0,0,0,0,0,0,0] };
const run = (p = {}, d = data) => strategy.run(d, { ...base, ...p });
const row = (r, i) => r.log.find(r => r.date === dates[i]);
const close = (a,b) => assert(Math.abs(a-b) < 1e-8*Math.max(1,Math.abs(b)), `${a} != ${b}`);
assert.deepEqual(run(), run({nextClose:false}));
assert.deepEqual(run(), run({nextClose:'false'}));
const delayed = run({nextClose:true});
assert.equal(row(delayed,0).held, 'CASH');
assert.equal(row(delayed,1).held, 'TQQQ');
close(row(delayed,1).price,100);
// Monday's stretch signal fills Tuesday despite Tuesday's normal-band reversal.
assert.equal(row(delayed,3).held,'SQQQ');
close(row(delayed,3).price,180); // sale price, not signal-day 200
close(row(delayed,3).shares,1800/130);
assert.match(row(delayed,3).note,/Signal 2024-01-08/);
assert.equal(row(delayed,4).held,'TQQQ');
assert.equal(row(delayed,5).held,'CASH'); // crash exit from previous close
assert.equal(row(delayed,6).held,'TQQQ'); // final-day stretch signal remains unfilled
const credit = {...data, tqqq:[100,100,100,100,100,100,100], nfci:[0,1,0,0,0,0,0]};
const veto = run({nextClose:true},credit);
assert.equal(row(veto,1).held,'TQQQ'); // yesterday's entry still executes
assert.equal(row(veto,2).held,'CASH'); // Friday veto fills Monday, despite recovery
assert.match(row(veto,2).note,/Signal 2024-01-05.*credit veto/);
assert.equal(row(veto,3).held,'TQQQ');
const split = run({nextClose:true,splitDays:true});
assert.equal(row(split,3).held,'CASH');
assert.equal(row(split,4).held,'TQQQ'); // re-check normal; no obsolete hedge buy
const short = run({nextClose:true,endIdx:0});
assert.equal(short.log.length,1); assert.equal(short.log[0].held,'CASH');
close(short.log[0].value,1000);
const fee = run({nextClose:true,tradeCost:1,contributions:{[dates[1]]:100}});
close(row(fee,1).fee,11); close(row(fee,1).shares,10.89);
assert.equal(row(fee,1).contributed,100);
for (const splitDays of [false,true]) {
  const taxed = run({nextClose:true,splitDays,tax:{enabled:true,fx:1,ppiGrowth:0}});
  assert(taxed.log.every(r=>Number.isFinite(r.value) && r.value>=0));
  assert(taxed.taxPayments.length);
}
// Existing saved copies expose and execute the new option without rewriting stored code.
ctx.window = {STRATEGY_CODE:{44:code}};
const oldCode = code.replace(/    \{ id: "nextClose"[^\n]+\n/, '');
ctx.oldCode = oldCode;
assert.equal(vm.runInContext('effectiveTaxStrategyCode(oldCode)',ctx),code);
console.log('Next-close: entry, weekend veto, reversal, SQQQ switch, crash exit, split-day re-check, final boundary, fees, contributions and taxes passed.');
