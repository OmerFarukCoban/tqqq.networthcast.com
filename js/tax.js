// Türkiye tax estimate & strategy-aware yearly holding P/L engine.
// Current-law 2026 scenario (GİB 332 Seri No'lu Tebliğ), not a reconstruction
// of historical Turkish tax regimes. Details and limits: TAXES.md.
const TURKEY_TAX_2026 = [[190000, .15], [400000, .20], [1000000, .27], [5300000, .35], [Infinity, .40]];
const TURKEY_INTEREST_THRESHOLD_TRY = 22000;
const TAX_FUND_KEYS = ['tqqq', 'qqq', 'spy', 'qld', 'sso', 'spxl', 'sqqq', 'gld', 'soxl', 'soxx'];

function turkeyIncomeTax(income, usdTry) {
  const fx = Number.isFinite(usdTry) && usdTry > 0 ? usdTry : 1;
  let tax = 0, previous = 0;
  for (const [ceiling, rate] of TURKEY_TAX_2026) {
    const usdCeiling = ceiling / fx;
    tax += Math.max(0, Math.min(income, usdCeiling) - previous) * rate;
    if (income <= usdCeiling) break;
    previous = usdCeiling;
  }
  return tax;
}

function readTaxSettings() {
  if (typeof document === 'undefined') return { enabled: false, fx: 40, ppiGrowth: 0, fxGrowth: 0 };
  const get = id => document.getElementById(id);
  const number = (id, fallback, min, max) => {
    const el = get(id);
    if (!el || el.value === '') return fallback;
    const value = Number(el.value);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    enabled: get('tax-enabled')?.value === '1',
    fx: number('tax-fx', 40, .01, 1000000),
    ppiGrowth: number('tax-ppi-growth', 0, 0, 500) / 100,
    fxGrowth: number('tax-fx-growth', 0, -90, 500) / 100,
  };
}

function taxSettingsKey() { return JSON.stringify(readTaxSettings()); }

function taxStrategyLabel(cfg) {
  if (!readTaxSettings().enabled || !cfg || cfg.type !== 'custom') return cfg ? cfg.name : '';
  const res = typeof window !== 'undefined' && window._customResults ? window._customResults[cfg.id] : null;
  if (res && res.taxApplied === false) return cfg.name + ' (pre-tax)';
  return cfg.name;
}

class TurkeyTaxLedger {
  constructor(settings, startDate) {
    this.settings = settings || {};
    this.startDate = startDate || '2010-01-01';
    this.startMs = Date.parse(this.startDate + 'T00:00:00Z') || 0;
    this.lots = new Map();
    this.gains = 0;
    this.realizedProfit = 0;
    this.realizedLoss = 0;
    this.interest = 0;
    this.payments = [];
  }
  ppi(date) {
    // Both purchase and sale use the preceding month's index (GVK mük. 81).
    const month = +date.slice(0, 4) * 12 + +date.slice(5, 7) - 2;
    if (this.settings.ppiAt) return this.settings.ppiAt(month);
    const start = +this.startDate.slice(0, 4) * 12 + +this.startDate.slice(5, 7) - 2;
    return 100 * Math.pow(1 + (this.settings.ppiGrowth || 0), (month - start) / 12);
  }
  fxAt(date) {
    const fx0 = Number.isFinite(this.settings.fx) && this.settings.fx > 0 ? this.settings.fx : 40;
    if (this.settings.fxAt) return this.settings.fxAt(date);
    const fxGrowth = this.settings.fxGrowth || 0;
    if (!fxGrowth) return fx0;
    const ms = Date.parse(date + 'T00:00:00Z');
    const years = Number.isFinite(ms) ? (ms - this.startMs) / (365.25 * 86400000) : 0;
    return fx0 * Math.pow(1 + fxGrowth, years);
  }
  buy(asset, quantity, dollars, date) {
    if (!(quantity > 0)) return;
    if (!this.lots.has(asset)) this.lots.set(asset, []);
    this.lots.get(asset).push({
      quantity,
      basis: dollars / quantity,
      ppi: this.ppi(date),
      fx: this.fxAt(date),
    });
  }
  sell(asset, quantity, dollars, date) {
    if (!(quantity > 0)) return;
    const lots = this.lots.get(asset) || [];
    let remaining = quantity, basis = 0;
    const ppiNow = this.ppi(date);
    const fxNow = this.fxAt(date);
    while (remaining > 1e-10 && lots.length) {
      const lot = lots[0], used = Math.min(remaining, lot.quantity);
      const ratio = ppiNow / lot.ppi;
      const indexFactor = ratio >= 1.1 - 1e-12 ? ratio : 1;
      // Exact GVK mük. 81 in TRY, converted back to sale-date USD:
      //   costTry * indexFactor / fxNow = costUsd * (lot.fx / fxNow) * indexFactor.
      // When ppiGrowth === 0 and fxGrowth === 0, reduces to exact USD FIFO.
      const fxFactor = fxNow > 0 ? (lot.fx / fxNow) : 1;
      basis += used * lot.basis * fxFactor * indexFactor;
      lot.quantity -= used;
      remaining -= used;
      if (lot.quantity <= 1e-10) lots.shift();
    }
    if (remaining > Math.max(1e-7, quantity * 1e-8)) throw new Error('Tax sale exceeds recorded holdings: ' + asset);
    const gain = dollars - basis;
    this.gains += gain;
    if (gain >= 0) this.realizedProfit += gain;
    else this.realizedLoss += -gain;
  }
  addInterest(dollars) { this.interest += dollars; }
  due() {
    // Brackets are converted once using current USD/TRY (`fx`), keeping real USD
    // bracket widths consistent across multi-decade runs (approximating annual
    // Yeniden Değerleme Oranı revaluations). The ₺22,000 interest threshold is
    // a declaration cliff (not a deduction); capital losses cannot offset interest.
    const fx = Number.isFinite(this.settings.fx) && this.settings.fx > 0 ? this.settings.fx : 40;
    const taxableInterest = this.interest > TURKEY_INTEREST_THRESHOLD_TRY / fx ? this.interest : 0;
    return turkeyIncomeTax(Math.max(0, this.gains) + taxableInterest, fx);
  }
  settle(date, cash, liquidate) {
    let paid = 0;
    // Funding sales themselves realize gains/losses in this same tax year.
    // Recompute until the marginal tax on those sales has also been funded.
    for (let i = 0; i < 80; i++) {
      const balance = this.due() - paid;
      if (Math.abs(balance) < 1e-8) break;
      if (balance > cash && liquidate) cash += liquidate(balance - Math.max(0, cash));
      cash -= balance;
      paid += balance;
    }
    const fx = Number.isFinite(this.settings.fx) && this.settings.fx > 0 ? this.settings.fx : 40;
    const taxableInterest = this.interest > TURKEY_INTEREST_THRESHOLD_TRY / fx ? this.interest : 0;
    this.payments.push({
      date, year: +date.slice(0, 4),
      profitUSD: this.realizedProfit, lossUSD: this.realizedLoss,
      gainsUSD: this.gains, interestUSD: this.interest,
      taxableIncomeUSD: Math.max(0, this.gains) + taxableInterest,
      taxUSD: paid,
    });
    this.gains = 0;
    this.realizedProfit = 0;
    this.realizedLoss = 0;
    this.interest = 0;
    return cash;
  }
}

function taxClosesYear(date, nextDate, endDate) {
  return date === endDate || (nextDate && date.slice(0, 4) !== nextDate.slice(0, 4));
}

function createTurkeyTax(opts, startDate) {
  const settings = opts && opts.tax != null ? opts.tax : readTaxSettings();
  return settings && settings.enabled ? new TurkeyTaxLedger(settings, startDate) : null;
}

// Reconstruct daily share holdings and active strategy-action sleeves from any
// custom/library run (`res.holdings` when present, else `res.log`).
// Returns null if the strategy emits neither `holdings` nor `held` labels.
function buildDailyHoldingsFromCustom(res, data, startIdx, endIdx) {
  if (!data || !Array.isArray(data.dates) || !data.dates.length) return null;
  const rawLog = Array.isArray(res) ? res : (res && Array.isArray(res.log) ? res.log : []);
  const rawHoldings = res && Array.isArray(res.holdings) && res.holdings.length ? res.holdings : null;
  if (!rawHoldings && !rawLog.length) return null;

  const dateToIdx = new Map();
  for (let i = 0; i < data.dates.length; i++) dateToIdx.set(data.dates[i], i);

  // Determine active [sIdx..eIdx] bounds from the emitted log/holdings so warmup
  // days before entry are never included.
  const firstDate = rawLog.length ? rawLog[0].date : rawHoldings[0].date;
  const lastDate = rawLog.length ? rawLog[rawLog.length - 1].date : rawHoldings[rawHoldings.length - 1].date;
  let sIdx = dateToIdx.has(firstDate) ? dateToIdx.get(firstDate) : (startIdx || 0);
  let eIdx = dateToIdx.has(lastDate) ? dateToIdx.get(lastDate) : (endIdx != null ? endIdx : data.dates.length - 1);
  if (sIdx > eIdx) return null;

  // Map log rows by date for sleeve tracking & single-asset share reconstruction.
  const logByDate = new Map();
  let anyHeld = false;
  for (let li = 0; li < rawLog.length; li++) {
    const row = rawLog[li];
    if (!row || row.date == null) continue;
    if (typeof row.held === 'string') anyHeld = true;
    logByDate.set(String(row.date), row);
  }
  if (!rawHoldings && !anyHeld) return null;

  const holdByDate = rawHoldings ? new Map() : null;
  if (rawHoldings) {
    for (let hi = 0; hi < rawHoldings.length; hi++) {
      const he = rawHoldings[hi];
      if (!he || he.date == null) continue;
      holdByDate.set(String(he.date), he);
    }
  }

  const parseRowHoldings = (row, idx) => {
    const h = {};
    let cash = 0;
    if (!row || typeof row.held !== 'string') return null;
    if (typeof row.cash === 'number' && typeof row.shares === 'number') {
      const fk = row.held.toLowerCase().trim();
      if (fk !== 'cash' && row.shares > 0 && data[fk]) h[fk] = row.shares;
      cash = row.cash;
      return { h, cash };
    }
    if (typeof row.value === 'number') {
      const parts = row.held.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
      const funds = parts.filter(s => s !== 'cash');
      let part = parts.length === 1 ? (funds.length ? 1 : 0) : null;
      if (part == null) {
        if (typeof row.share === 'number') part = row.share / 100;
        else if (typeof row.weight === 'number') part = row.weight;
        else part = 1;
      }
      if (funds.length === 1 && data[funds[0]] && data[funds[0]][idx] > 0) {
        if (part > 0) h[funds[0]] = (row.value * part) / data[funds[0]][idx];
        cash = row.value * (1 - part);
        return { h, cash };
      }
      if (funds.length === 0) return { h, cash: row.value };
    }
    return null;
  };

  const out = [];
  let curH = {}, curCash = 0;
  let activeTm = false, activeDip = false;
  let tmSig = 'tqqq', tmMode = 'close', dipUntil = '';
  for (let i = sIdx; i <= eIdx; i++) {
    const date = data.dates[i];
    const logRow = logByDate.get(date) || null;
    if (holdByDate && holdByDate.has(date)) {
      const he = holdByDate.get(date);
      const nh = {};
      if (he.h) {
        for (const fk in he.h) {
          if (typeof he.h[fk] === 'number' && he.h[fk] > 1e-12 && data[fk]) nh[fk] = he.h[fk];
        }
      }
      curH = nh;
      curCash = typeof he.cash === 'number' ? he.cash : 0;
    } else if (!holdByDate && logRow) {
      const parsed = parseRowHoldings(logRow, i);
      if (parsed) { curH = parsed.h; curCash = parsed.cash; }
    }

    // Track strategy overlay sleeves (Turnaround Monday, Month-end dip, Big days).
    // Note: sanitized logs strip null fields, so every log row that omits a
    // truthy tmTrade/dipTrade cleanly clears that sleeve. On sparse (non-daily)
    // logs, also detect silent handoffs to base TQQQ when a Monday exit or
    // month-end close date passes without selling. Big days is strictly 1 day.
    let daySleeve = null;
    if (logRow) {
      activeTm = !!logRow.tmTrade;
      activeDip = !!logRow.dipTrade;
      if (activeTm && typeof logRow.note === 'string') {
        if (/\bSPY\b/.test(logRow.note)) tmSig = 'spy';
        else if (/\bTQQQ\b/.test(logRow.note)) tmSig = 'tqqq';
        if (logRow.note.includes("prior day's low")) tmMode = 'hl';
        else if (logRow.note.includes('prior close')) tmMode = 'close';
      }
      if (activeDip && typeof logRow.note === 'string') {
        const dm = /held until the close of (\d{4}-\d{2}-\d{2})/.exec(logRow.note);
        if (dm) dipUntil = dm[1];
      } else if (!activeDip) {
        dipUntil = '';
      }
    } else {
      if (activeTm && i > 0 && data[tmSig]) {
        const cNow = data[tmSig][i], cPrev = data[tmSig][i - 1];
        const hiArr = tmMode === 'hl' ? data[tmSig + 'High'] : null;
        const exitLvl = (hiArr && hiArr[i - 1] > 0) ? hiArr[i - 1] : cPrev;
        if (cNow > 0 && exitLvl > 0 && cNow > exitLvl) activeTm = false;
      }
      if (activeDip && dipUntil && date >= dipUntil) {
        activeDip = false;
        dipUntil = '';
      }
    }
    const heldFunds = Object.keys(curH);
    const bigDayBuyToday = !!(logRow && logRow.bigDay && heldFunds.length > 0 &&
      (logRow.held ? String(logRow.held).toUpperCase() !== 'CASH' : true));
    if (bigDayBuyToday) {
      daySleeve = 'bigDays';
    } else if (activeTm && (curH.tqqq > 0 || heldFunds.length === 1)) {
      daySleeve = 'turnaroundMonday';
    } else if (activeDip && (curH.tqqq > 0 || heldFunds.length === 1)) {
      daySleeve = 'monthEndDip';
    }

    out.push({ idx: i, date, h: Object.assign({}, curH), cash: curCash, sleeve: daySleeve });
  }
  return out;
}

// Compute strategy-aware yearly close-to-close holding P/L from daily holdings.
// Splits overlay-driven holds (Turnaround Monday, Month-end dip, Big days) into
// their own columns alongside each held fund so the user sees exactly where
// gains came from each year and overall.
function computeAnnualHoldingPnl(dailyHoldings, data, taxApplied) {
  if (!dailyHoldings || dailyHoldings.length < 2 || !data) return null;
  const SLEEVE_LABELS = {
    turnaroundMonday: 'Turnaround Monday',
    monthEndDip: 'Month-end dip',
    bigDays: 'Big days',
  };
  const byYear = {};
  const colActivity = {};
  const colOrder = [];
  const touchCol = (key) => {
    if (!colActivity[key]) { colActivity[key] = true; colOrder.push(key); }
  };

  for (let k = 1; k < dailyHoldings.length; k++) {
    const prev = dailyHoldings[k - 1], cur = dailyHoldings[k];
    const year = +cur.date.slice(0, 4);
    if (!byYear[year]) byYear[year] = { year, values: {}, total: 0 };
    const row = byYear[year];
    const prevFunds = Object.keys(prev.h);
    const overlayFund = prev.sleeve ? (prev.h.tqqq > 0 ? 'tqqq' : (prevFunds.length === 1 ? prevFunds[0] : null)) : null;

    for (let fi = 0; fi < prevFunds.length; fi++) {
      const f = prevFunds[fi];
      const sh = prev.h[f];
      if (!(sh > 0) || !data[f]) continue;
      const pPrev = data[f][prev.idx], pNow = data[f][cur.idx];
      if (!(pPrev > 0) || !(pNow > 0)) continue;
      const pnl = sh * (pNow - pPrev);
      const colKey = (prev.sleeve && f === overlayFund) ? prev.sleeve : f;
      touchCol(colKey);
      row.values[colKey] = (row.values[colKey] || 0) + pnl;
      row.total += pnl;
    }
  }

  if (!colOrder.length) return null;
  // Order columns cleanly: funds first (TQQQ, SOXL, SQQQ, QQQ, SPY, ...), then action sleeves.
  const sleeveKeys = ['turnaroundMonday', 'monthEndDip', 'bigDays'];
  const fundPref = ['tqqq', 'soxl', 'sqqq', 'qqq', 'qld', 'spy', 'spxl', 'sso', 'gld', 'soxx'];
  colOrder.sort((a, b) => {
    const aS = sleeveKeys.indexOf(a), bS = sleeveKeys.indexOf(b);
    if (aS >= 0 && bS >= 0) return aS - bS;
    if (aS >= 0) return 1;
    if (bS >= 0) return -1;
    const aF = fundPref.indexOf(a), bF = fundPref.indexOf(b);
    if (aF >= 0 && bF >= 0) return aF - bF;
    if (aF >= 0) return -1;
    if (bF >= 0) return 1;
    return a < b ? -1 : 1;
  });

  const columns = colOrder.map(key => ({
    key,
    label: SLEEVE_LABELS[key] || key.toUpperCase(),
    isAction: sleeveKeys.indexOf(key) >= 0,
  }));
  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const rows = years.map(y => byYear[y]);
  const totals = { values: {}, total: 0 };
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    totals.total += r.total;
    for (let ci = 0; ci < columns.length; ci++) {
      const k = columns[ci].key;
      totals.values[k] = (totals.values[k] || 0) + (r.values[k] || 0);
    }
  }
  return { columns, rows, totals, taxApplied: !!taxApplied };
}

// Universal Türkiye tax replayer for ANY library or custom strategy that reports
// `holdings` or `held` in `log`. Replays the strategy's exact share-change events
// day-by-day on a taxed account with FIFO lots, FX+PPI indexation, cash interest,
// trading costs, contributions/withdrawals, and Dec 31 tax settlement.
function applyTurkeyTaxToCustomRun(res, data, p, taxSettings, isOwnMoney) {
  const preDaily = buildDailyHoldingsFromCustom(res, data, p && p.startIdx, p && p.endIdx);
  if (!taxSettings || !taxSettings.enabled) {
    return {
      daily: preDaily,
      taxApplied: null,
      taxPayments: [],
      annualHoldingPnl: computeAnnualHoldingPnl(preDaily, data, false),
    };
  }
  // Strategies backed by native simulate()/simulateSMA() (9Sig/SMA library entries)
  // already executed TurkeyTaxLedger natively.
  if (res && res.taxApplied) {
    return {
      daily: preDaily,
      taxApplied: true,
      taxPayments: Array.isArray(res.taxPayments) ? res.taxPayments : [],
      annualHoldingPnl: computeAnnualHoldingPnl(preDaily, data, true),
    };
  }
  if (!preDaily || !preDaily.length) {
    return { daily: null, taxApplied: false, taxPayments: [], annualHoldingPnl: null };
  }

  const rawLog = Array.isArray(res) ? res : (res && Array.isArray(res.log) ? res.log : []);
  // Infer trading cost rate & daily cash interest rate from params or pre-tax log.
  let cost = 0;
  if (p && p.tradeCost != null && isFinite(+p.tradeCost)) {
    cost = Math.max(0, +p.tradeCost) / 100;
  } else {
    for (let li = 0; li < rawLog.length; li++) {
      const r = rawLog[li];
      if (r && r.fee > 0 && r.value > 0 && (r.action === 'buy' || r.action === 'sell')) {
        cost = Math.min(0.05, r.fee / (r.value + r.fee));
        break;
      }
    }
  }
  let dayRate = 0;
  if (p && p.cashRate != null && isFinite(+p.cashRate)) {
    dayRate = Math.pow(1 + Math.max(0, +p.cashRate) / 100, 1 / 252) - 1;
  } else {
    // Infer daily cash rate from two all-cash log rows with no contributions between them.
    const dIdx = new Map();
    for (let i = 0; i < data.dates.length; i++) dIdx.set(data.dates[i], i);
    for (let li = 1; li < rawLog.length; li++) {
      const a = rawLog[li - 1], b = rawLog[li];
      if (!a || !b || String(a.held || '').toUpperCase() !== 'CASH' || String(b.held || '').toUpperCase() !== 'CASH') continue;
      if ((b.contributed || 0) !== 0) continue;
      const ia = dIdx.get(String(a.date)), ib = dIdx.get(String(b.date));
      const va = typeof a.cash === 'number' ? a.cash : a.value;
      const vb = typeof b.cash === 'number' ? b.cash : b.value;
      if (ia != null && ib != null && ib > ia && va > 0 && vb > va) {
        const rate = Math.pow(vb / va, 1 / (ib - ia)) - 1;
        if (rate >= 0 && rate < 0.005) { dayRate = rate; break; }
      }
    }
  }

  // Per-date contribution map (own-money strategies read from log.contributed).
  const contribByDate = new Map();
  if (isOwnMoney) {
    for (let li = 0; li < rawLog.length; li++) {
      const r = rawLog[li];
      if (r && r.date != null && typeof r.contributed === 'number' && r.contributed !== 0) {
        contribByDate.set(String(r.date), (contribByDate.get(String(r.date)) || 0) + r.contributed);
      }
    }
  } else if (p && p.contributions) {
    for (const d in p.contributions) contribByDate.set(d, +p.contributions[d] || 0);
  }

  const pxOf = (f, idx) => (data[f] && data[f][idx] > 0) ? data[f][idx] : 0;
  const valOf = (hMap, cVal, idx) => {
    let v = cVal;
    for (const f in hMap) v += hMap[f] * pxOf(f, idx);
    return v;
  };

  const tax = new TurkeyTaxLedger(taxSettings, preDaily[0].date);
  const h = {};
  const endDate = preDaily[preDaily.length - 1].date;
  let cash = isOwnMoney ? (contribByDate.get(preDaily[0].date) || valOf(preDaily[0].h, preDaily[0].cash, preDaily[0].idx))
    : ((p && typeof p.initial === 'number' ? p.initial : 0) + (contribByDate.get(preDaily[0].date) || 0));

  const postDaily = [];
  const postByDate = new Map();

  for (let k = 0; k < preDaily.length; k++) {
    const pd = preDaily[k], i = pd.idx, date = pd.date;
    let dayFee = 0, dayTax = 0;

    if (k === 0) {
      // Day 0: match pre-tax initial allocation (already post-warmup).
      let preInv = 0;
      for (const f in pd.h) preInv += pd.h[f] * pxOf(f, i);
      const preTot = preInv + Math.max(0, pd.cash);
      if (preTot > 0 && preInv > 0 && cash > 0) {
        const investCash = cash * (preInv / preTot);
        for (const f in pd.h) {
          const px = pxOf(f, i);
          if (!(px > 0)) continue;
          const spend = investCash * ((pd.h[f] * px) / preInv);
          const fCost = spend * cost;
          const sh = (spend - fCost) / px;
          h[f] = sh;
          tax.buy(f, sh, spend, date);
          cash -= spend;
          dayFee += fCost;
        }
        if (Math.abs(cash) < 1e-9) cash = 0;
      }
    } else {
      const prev = preDaily[k - 1];
      // 1. Daily cash interest on positive cash carried into today.
      if (cash > 0 && dayRate > 0) {
        const intr = cash * dayRate;
        tax.addInterest(intr, date);
        cash += intr;
      }
      // 2. Contribution or withdrawal.
      const amt = contribByDate.get(date) || 0;
      if (amt > 0) {
        cash += amt;
      } else if (amt < 0) {
        let need = -amt;
        const fromCash = Math.min(Math.max(cash, 0), need);
        cash -= fromCash;
        need -= fromCash;
        if (need > 1e-9) {
          const heldKeys = Object.keys(h);
          let totHeld = 0;
          for (let fi = 0; fi < heldKeys.length; fi++) totHeld += h[heldKeys[fi]] * pxOf(heldKeys[fi], i);
          if (totHeld > 0) {
            for (let fi = 0; fi < heldKeys.length; fi++) {
              const f = heldKeys[fi], px = pxOf(f, i);
              if (!(px > 0) || !(h[f] > 0)) continue;
              const fVal = h[f] * px;
              const targetNet = need * (fVal / totHeld);
              const gross = Math.min(fVal, targetNet / (1 - cost));
              const sold = gross / px, fCost = gross * cost, proceeds = gross - fCost;
              tax.sell(f, sold, proceeds, date);
              h[f] -= sold;
              if (h[f] <= 1e-10) delete h[f];
              dayFee += fCost;
            }
          }
        }
      }

      // 3. Replay pre-tax share changes (zero trades on quiet hold days!).
      const allFunds = new Set(Object.keys(prev.h).concat(Object.keys(pd.h)));
      // 3a. Sells (any fund whose pre-tax shares decreased).
      for (const f of allFunds) {
        const prevSh = prev.h[f] || 0, curSh = pd.h[f] || 0;
        if (prevSh > 1e-12 && curSh < prevSh - 1e-9 * prevSh && h[f] > 0) {
          const px = pxOf(f, i);
          if (!(px > 0)) continue;
          const sellFrac = Math.min(1, (prevSh - curSh) / prevSh);
          const sold = sellFrac >= 1 - 1e-9 ? h[f] : h[f] * sellFrac;
          const gross = sold * px, fCost = gross * cost, proceeds = gross - fCost;
          tax.sell(f, sold, proceeds, date);
          h[f] -= sold;
          if (h[f] <= 1e-10) delete h[f];
          cash += proceeds;
          dayFee += fCost;
        }
      }
      // 3b. Buys (any fund whose pre-tax shares increased).
      const buyDollars = {};
      let sumBuyD = 0;
      for (const f of allFunds) {
        const prevSh = prev.h[f] || 0, curSh = pd.h[f] || 0;
        if (curSh > prevSh + 1e-9 * Math.max(1, prevSh)) {
          const px = pxOf(f, i);
          if (px > 0) {
            const d = (curSh - prevSh) * px;
            buyDollars[f] = d;
            sumBuyD += d;
          }
        }
      }
      if (sumBuyD > 0 && cash > 1e-9) {
        const preCashAfter = Math.max(0, pd.cash);
        const deployFrac = preCashAfter <= 1e-6 * (sumBuyD + preCashAfter)
          ? 1 : (sumBuyD / (sumBuyD + preCashAfter));
        const spendTotal = cash * deployFrac;
        for (const f in buyDollars) {
          const px = pxOf(f, i);
          if (!(px > 0)) continue;
          const spend = spendTotal * (buyDollars[f] / sumBuyD);
          const fCost = spend * cost;
          const bought = (spend - fCost) / px;
          h[f] = (h[f] || 0) + bought;
          tax.buy(f, bought, spend, date);
          cash -= spend;
          dayFee += fCost;
        }
        if (Math.abs(cash) < 1e-9) cash = 0;
      }
    }

    // 4. Year-end / final-day tax settlement.
    const nextDate = k + 1 < preDaily.length ? preDaily[k + 1].date : null;
    if (taxClosesYear(date, nextDate, endDate)) {
      cash = tax.settle(date, cash, (need) => {
        const heldKeys = Object.keys(h);
        let totHeld = 0;
        for (let fi = 0; fi < heldKeys.length; fi++) totHeld += h[heldKeys[fi]] * pxOf(heldKeys[fi], i);
        if (!(totHeld > 0)) return 0;
        let raised = 0;
        for (let fi = 0; fi < heldKeys.length; fi++) {
          const f = heldKeys[fi], px = pxOf(f, i);
          if (!(px > 0) || !(h[f] > 0)) continue;
          const fVal = h[f] * px;
          const shareNeed = need * (fVal / totHeld);
          const gross = Math.min(fVal, shareNeed / (1 - cost));
          const sold = gross / px, fCost = gross * cost, proceeds = gross - fCost;
          tax.sell(f, sold, proceeds, date);
          h[f] -= sold;
          if (h[f] <= 1e-10) delete h[f];
          dayFee += fCost;
          raised += proceeds;
        }
        return raised;
      });
      const payment = tax.payments[tax.payments.length - 1];
      dayTax = payment ? payment.taxUSD : 0;
    }

    const totalVal = valOf(h, cash, i);
    const snap = { idx: i, date, h: Object.assign({}, h), cash, sleeve: pd.sleeve, value: totalVal, fee: dayFee, tax: dayTax };
    postDaily.push(snap);
    postByDate.set(date, snap);
  }

  // Patch the strategy's log rows with taxed portfolio values, holdings, and tax paid.
  const seenLogDates = new Set();
  const nextLog = [];
  for (let li = 0; li < rawLog.length; li++) {
    const row = rawLog[li];
    if (!row || row.date == null) continue;
    const d = String(row.date);
    seenLogDates.add(d);
    const snap = postByDate.get(d);
    if (!snap) { nextLog.push(row); continue; }
    const copy = Object.assign({}, row, {
      value: snap.value,
      cash: snap.cash,
      holdingsValue: snap.value - snap.cash,
    });
    const keys = Object.keys(snap.h);
    if (keys.length === 1 && 'shares' in row) copy.shares = snap.h[keys[0]];
    else if (keys.length === 0 && 'shares' in row) copy.shares = 0;
    if ('fee' in row) copy.fee = snap.fee;
    if (snap.tax > 0) {
      copy.tax = snap.tax;
      if (copy.action === 'hold') copy.action = 'tax';
      copy.note = (copy.note ? copy.note + ' · ' : '') + 'Türkiye tax $' + Math.round(snap.tax).toLocaleString('en-US');
    }
    nextLog.push(copy);
  }
  // Ensure every year-end tax payment appears in the log (even in weeklyDisplay mode).
  for (let pi = 0; pi < tax.payments.length; pi++) {
    const pay = tax.payments[pi];
    if (!(pay.taxUSD > 0) || seenLogDates.has(pay.date)) continue;
    const snap = postByDate.get(pay.date);
    if (!snap) continue;
    const keys = Object.keys(snap.h);
    nextLog.push({
      date: pay.date, value: snap.value, action: 'tax',
      held: keys.length ? keys.map(f => f.toUpperCase()).join(' + ') : 'CASH',
      price: keys.length === 1 ? pxOf(keys[0], snap.idx) : 0,
      shares: keys.length === 1 ? snap.h[keys[0]] : 0,
      holdingsValue: snap.value - snap.cash,
      cash: snap.cash, fee: snap.fee, tax: snap.tax,
      note: 'Türkiye tax $' + Math.round(snap.tax).toLocaleString('en-US'),
    });
  }
  nextLog.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const holdingsOut = postDaily.map(s => ({ date: s.date, h: s.h, cash: s.cash }));
  return {
    log: nextLog,
    holdings: holdingsOut,
    daily: postDaily,
    taxApplied: true,
    taxPayments: tax.payments,
    annualHoldingPnl: computeAnnualHoldingPnl(postDaily, data, true),
  };
}

// Compute yearly holding P/L for native engines (9Sig, SMA, Buy & Hold) from
// their daily/control-point holdings + global `daily` rows.
function computeNativeAnnualHoldingPnl(controls, dailyArr, taxApplied) {
  if (!controls || !controls.length || !dailyArr || !dailyArr.length) return null;
  const dateToIdx = new Map();
  for (let i = 0; i < dailyArr.length; i++) dateToIdx.set(dailyArr[i].date, i);
  const sIdx = dateToIdx.get(controls[0].date);
  const lastDate = controls[controls.length - 1].date;
  const eIdx = dateToIdx.get(lastDate);
  if (sIdx == null || eIdx == null || sIdx >= eIdx) return null;

  // Build compact column-oriented price view for computeAnnualHoldingPnl.
  const data = { dates: dailyArr.map(d => d.date) };
  for (const fk of TAX_FUND_KEYS) data[fk] = dailyArr.map(d => d[fk] || 0);

  const dailyHoldings = [];
  let ci = 0;
  for (let i = sIdx; i <= eIdx; i++) {
    const dt = dailyArr[i].date;
    while (ci + 1 < controls.length && controls[ci + 1].date <= dt) ci++;
    const c = controls[ci];
    const h = {};
    if (c.h) {
      for (const fk in c.h) if (c.h[fk] > 1e-12) h[fk] = c.h[fk];
    } else if (c.fund && c.shares > 1e-12) {
      h[c.fund] = c.shares;
    }
    dailyHoldings.push({ idx: i, date: dt, h, cash: c.cash || 0, sleeve: null });
  }
  return computeAnnualHoldingPnl(dailyHoldings, data, taxApplied);
}

function annualHoldingPnlTableHtml(pnl) {
  if (!pnl || !pnl.rows || !pnl.rows.length || !pnl.columns || !pnl.columns.length) return '';
  const money = (value) => {
    const n = Number(value) || 0;
    if (Math.abs(n) < 0.5) return '$0';
    const sign = n > 0 ? '+' : '−';
    return sign + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  };
  const cls = (v) => (v > 0.5 ? 'positive' : v < -0.5 ? 'negative' : '');
  const cell = (v) => `<td class="${cls(v)}">${money(v)}</td>`;
  const heads = pnl.columns.map(c => `<th>${c.label}${c.isAction ? '' : ' P/L'}</th>`).join('');
  const body = pnl.rows.map(row => {
    const cols = pnl.columns.map(c => cell(row.values[c.key] || 0)).join('');
    return `<tr><td>${row.year}</td>${cols}${cell(row.total)}</tr>`;
  }).join('');

  const absTotal = Math.abs(pnl.totals.total);
  const sumAbs = pnl.columns.reduce((s, c) => s + Math.abs(pnl.totals.values[c.key] || 0), 0);
  const shareBase = absTotal > 1 ? pnl.totals.total : sumAbs;
  const footCols = pnl.columns.map(c => {
    const v = pnl.totals.values[c.key] || 0;
    const pct = shareBase ? ` <span class="pnl-share">(${Math.round((v / Math.abs(shareBase)) * 100)}%)</span>` : '';
    return `<td class="${cls(v)}"><strong>${money(v)}</strong>${pct}</td>`;
  }).join('');
  const hasActions = pnl.columns.some(c => c.isAction);
  const actionNote = hasActions
    ? ' Overlay rules (such as Turnaround Monday, Month-end dip, or Big days) are broken out separately from base fund holds so every column adds cleanly to Total P/L.'
    : '';
  const taxNote = pnl.taxApplied ? ' Share counts reflect annual Türkiye tax deductions.' : '';
  return `<div class="strategy-panel-section-label" style="margin-top:14px">Yearly holding profit/loss</div>
    <p class="holding-pnl-copy">Close-to-close dollar change while holding each fund or rule sleeve. Positions crossing year-end split across calendar years; contributions, trading fees, cash interest, and tax payments are excluded.${actionNote}${taxNote}</p>
    <div class="quarter-table-wrap holding-pnl-table-wrap"><table class="holding-pnl-year-table">
      <thead><tr><th>Year</th>${heads}<th>Total P/L</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr class="holding-pnl-total-row"><td><strong>All years</strong></td>${footCols}<td class="${cls(pnl.totals.total)}"><strong>${money(pnl.totals.total)}</strong></td></tr></tfoot>
    </table></div>`;
}

function taxAnnualTableHtml(payments) {
  if (!payments || !payments.length) return '';
  const usd = value => '$' + Math.round(value || 0).toLocaleString('en-US');
  const rows = payments.map(p => `<tr>
    <td>${p.year}</td><td class="positive">${usd(p.profitUSD)}</td>
    <td class="negative">${usd(p.lossUSD)}</td><td>${usd(p.gainsUSD)}</td>
    <td>${usd(p.interestUSD)}</td><td>${usd(p.taxableIncomeUSD)}</td>
    <td>${usd(p.taxUSD)}</td>
  </tr>`).join('');
  const sum = key => payments.reduce((s, p) => s + (p[key] || 0), 0);
  return `<div class="strategy-panel-section-label" style="margin-top:14px">Annual Türkiye tax</div>
    <p class="tax-detail-copy">2026 GİB non-wage brackets applied per calendar year (FIFO lots, GVK mük. 81 preceding-month Yİ-ÜFE indexing at ≥10% with TRY FX conversion, ₺22,000 foreign interest cliff). Paid at year-end in USD.</p>
    <div class="quarter-table-wrap tax-table-wrap"><table class="tax-year-table">
      <thead><tr><th>Year</th><th>Sale profit</th><th>Sale loss</th><th>Net sales</th><th>Interest</th><th>Taxable</th><th>Tax paid</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="holding-pnl-total-row"><td><strong>All years</strong></td><td class="positive"><strong>${usd(sum('profitUSD'))}</strong></td><td class="negative"><strong>${usd(sum('lossUSD'))}</strong></td><td><strong>${usd(sum('gainsUSD'))}</strong></td><td><strong>${usd(sum('interestUSD'))}</strong></td><td><strong>${usd(sum('taxableIncomeUSD'))}</strong></td><td><strong>${usd(sum('taxUSD'))}</strong></td></tr></tfoot>
    </table></div>`;
}

// Worker bundle: gives the sandboxed Web Worker the exact same tax ledger,
// universal tax replayer, and strategy-aware yearly P/L functions.
function turkeyTaxWorkerSource() {
  return 'const TURKEY_TAX_2026 = [' + TURKEY_TAX_2026.map(([l, r]) => '[' + l + ',' + r + ']').join(',') + '];\n'
    + 'const TURKEY_INTEREST_THRESHOLD_TRY = ' + TURKEY_INTEREST_THRESHOLD_TRY + ';\n'
    + 'const TAX_FUND_KEYS = ' + JSON.stringify(TAX_FUND_KEYS) + ';\n'
    + turkeyIncomeTax.toString() + '\n'
    + TurkeyTaxLedger.toString() + '\n'
    + taxClosesYear.toString() + '\n'
    + createTurkeyTax.toString() + '\n'
    + buildDailyHoldingsFromCustom.toString() + '\n'
    + computeAnnualHoldingPnl.toString() + '\n'
    + applyTurkeyTaxToCustomRun.toString() + '\n';
}

function syncTaxControls() {
  const settings = readTaxSettings();
  const enabled = settings.enabled;
  const button = document.getElementById('tax-toggle');
  if (!button) return;
  for (const [id, value] of Object.entries({
    'tax-fx': settings.fx,
    'tax-ppi-growth': +(settings.ppiGrowth * 100).toFixed(4),
    'tax-fx-growth': +(settings.fxGrowth * 100).toFixed(4),
  })) {
    const el = document.getElementById(id);
    if (el) el.value = String(value);
  }
  button.setAttribute('aria-pressed', String(enabled));
  button.textContent = 'Türkiye tax estimate: ' + (enabled ? 'on' : 'off');
  const box = document.getElementById('tax-assumptions');
  if (box) box.hidden = !enabled;
  const note = document.getElementById('tax-chart-note');
  if (note) note.hidden = !enabled;
  const warn = document.getElementById('tax-ppi-fx-warn');
  if (warn) {
    warn.hidden = !(settings.ppiGrowth > 0.05 && settings.fxGrowth === 0);
  }
  const thresholdCopy = document.getElementById('tax-usd-thresholds');
  if (thresholdCopy) {
    const usd = value => '$' + Math.round(value / settings.fx).toLocaleString('en-US');
    thresholdCopy.textContent = `At ${settings.fx.toLocaleString('en-US')} TRY/USD: 15% to ${usd(190000)}, 20% to ${usd(400000)}, 27% to ${usd(1000000)}, 35% to ${usd(5300000)}, then 40%. Foreign interest cliff: ${usd(TURKEY_INTEREST_THRESHOLD_TRY)}.`;
  }
}

function changeTaxSettings() {
  syncTaxControls();
  if (typeof saveSliders === 'function') saveSliders();
  if (typeof slInvalidateStats === 'function') slInvalidateStats();
  if (typeof render === 'function') render();
  if (typeof renderSavedConfigPills === 'function') renderSavedConfigPills();
  if (typeof isAnalyticsOpen === 'function' && isAnalyticsOpen() && typeof refreshAnalytics === 'function') refreshAnalytics();
  if (typeof isYearsHeldOpen === 'function' && isYearsHeldOpen() && typeof refreshYearsHeld === 'function') refreshYearsHeld();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TURKEY_TAX_2026, TURKEY_INTEREST_THRESHOLD_TRY, turkeyIncomeTax, TurkeyTaxLedger,
    taxClosesYear, createTurkeyTax, buildDailyHoldingsFromCustom, computeAnnualHoldingPnl,
    applyTurkeyTaxToCustomRun, computeNativeAnnualHoldingPnl, turkeyTaxWorkerSource,
  };
}
