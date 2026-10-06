// Current-law scenario, not a reconstruction of historical Turkish returns.
// Sources and limitations: TAXES.md. All portfolio amounts remain USD.
const TURKEY_TAX_2026 = [[190000, .15], [400000, .20], [1000000, .27], [5300000, .35], [Infinity, .40]];

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
  if (typeof document === 'undefined') return { enabled: false };
  const get = id => document.getElementById(id);
  const number = (id, fallback, min, max) => {
    const value = Number(get(id)?.value);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    enabled: get('tax-enabled')?.value === '1',
    fx: number('tax-fx', 40, .01, 1000000),
    ppiGrowth: number('tax-ppi-growth', 0, 0, 500) / 100,
  };
}

function taxSettingsKey() { return JSON.stringify(readTaxSettings()); }

function taxStrategyLabel(cfg) {
  return cfg.name + (readTaxSettings().enabled && cfg.type === 'custom' && !nfciSupportsTax(cfg.code) ? ' (pre-tax)' : '');
}

// Recognize this library strategy so existing saved copies lose their old
// "pre-tax" badge and receive the current tax and execution settings.
// The saved source and user parameters remain intact.
function nfciSupportsTax(code) {
  return typeof window !== 'undefined' && typeof code === 'string' &&
    code.includes('name: "NFCI veto, med stretch with SQQQ and med crash exit"') &&
    code.includes('NFCI credit veto');
}
function effectiveTaxStrategyCode(code) {
  return nfciSupportsTax(code) && (!code.includes('taxPayments: tax ? tax.payments : []') || !code.includes('annualHoldingPnl:') || !code.includes('id: "nextClose"'))
    ? window.STRATEGY_CODE[44] : code;
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
  return `<div class="strategy-panel-section-label" style="margin-top:14px">Annual Türkiye tax</div>
    <p class="tax-detail-copy">All amounts stay in USD. Profit and loss are shown separately; net sales gain is profit minus loss after eligible Yİ-ÜFE indexing. Positive net sales gain plus declarable cash interest forms taxable income. The current USD/TRY setting converts the Turkish lira thresholds to their USD equivalents, then the 15–40% tariff is applied and paid in USD.</p>
    <div class="quarter-table-wrap tax-table-wrap"><table class="tax-year-table">
      <thead><tr><th>Year</th><th>Sale profit</th><th>Sale loss</th><th>Net sales</th><th>Interest</th><th>Taxable</th><th>Tax paid</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// The worker gets the same ledger implementation as native simulations.
function turkeyTaxWorkerSource() {
  return 'const TURKEY_TAX_2026 = [' + TURKEY_TAX_2026.map(([limit, rate]) => '[' + limit + ',' + rate + ']').join(',') + '];\n' +
    turkeyIncomeTax.toString() + '\n' + TurkeyTaxLedger.toString() + '\n';
}

function createTurkeyTax(opts, startDate) {
  const settings = opts && opts.tax != null ? opts.tax : readTaxSettings();
  return settings.enabled ? new TurkeyTaxLedger(settings, startDate) : null;
}

class TurkeyTaxLedger {
  constructor(settings, startDate) {
    this.settings = settings;
    this.startDate = startDate;
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
  buy(asset, quantity, dollars, date) {
    if (!(quantity > 0)) return;
    if (!this.lots.has(asset)) this.lots.set(asset, []);
    this.lots.get(asset).push({ quantity, basis: dollars / quantity, ppi: this.ppi(date) });
  }
  sell(asset, quantity, dollars, date) {
    if (!(quantity > 0)) return;
    const lots = this.lots.get(asset) || [];
    let remaining = quantity, basis = 0;
    const ppi = this.ppi(date);
    while (remaining > 1e-10 && lots.length) {
      const lot = lots[0], used = Math.min(remaining, lot.quantity);
      const ratio = ppi / lot.ppi;
      basis += used * lot.basis * (ratio >= 1.1 - 1e-12 ? ratio : 1);
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
    // The declaration threshold is not a deduction. Capital losses offset
    // capital gains in this year only, and cannot offset interest income.
    const fx = this.settings.fx || 40;
    return turkeyIncomeTax(Math.max(0, this.gains) + (this.interest > 22000 / fx ? this.interest : 0), fx);
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
    const taxableInterest = this.interest > 22000 / (this.settings.fx || 40) ? this.interest : 0;
    this.payments.push({ date, year: +date.slice(0, 4),
      profitUSD: this.realizedProfit, lossUSD: this.realizedLoss,
      gainsUSD: this.gains, interestUSD: this.interest,
      taxableIncomeUSD: Math.max(0, this.gains) + taxableInterest,
      taxUSD: paid });
    this.gains = 0;
    this.realizedProfit = 0;
    this.realizedLoss = 0;
    this.interest = 0;
    return cash;
  }
}

// Shared by all native engines; explicit opts.tax also supports headless runs.
function taxClosesYear(date, nextDate, endDate) {
  return date === endDate || (nextDate && date.slice(0, 4) !== nextDate.slice(0, 4));
}

function syncTaxControls() {
  const settings = readTaxSettings();
  const enabled = settings.enabled;
  const button = document.getElementById('tax-toggle');
  if (!button) return;
  // URL and stored values must show the exact assumptions the engine uses.
  for (const [id, value] of Object.entries({ 'tax-fx': settings.fx, 'tax-ppi-growth': settings.ppiGrowth * 100 })) {
    document.getElementById(id).value = String(value);
  }
  button.setAttribute('aria-pressed', String(enabled));
  button.textContent = 'Türkiye tax estimate: ' + (enabled ? 'on' : 'off');
  document.getElementById('tax-assumptions').hidden = !enabled;
  document.getElementById('tax-chart-note').hidden = !enabled;
  const thresholdCopy = document.getElementById('tax-usd-thresholds');
  if (thresholdCopy) {
    const usd = value => '$' + Math.round(value / settings.fx).toLocaleString('en-US');
    thresholdCopy.textContent = `At ${settings.fx.toLocaleString('en-US')} TRY per USD: 15% to ${usd(190000)}, 20% to ${usd(400000)}, 27% to ${usd(1000000)}, 35% to ${usd(5300000)}, then 40%. The interest declaration threshold is ${usd(22000)}.`;
  }
}

function changeTaxSettings() {
  syncTaxControls();
  saveSliders();
  if (typeof slInvalidateStats === 'function') slInvalidateStats();
  render();
  if (typeof renderSavedConfigPills === 'function') renderSavedConfigPills();
}
