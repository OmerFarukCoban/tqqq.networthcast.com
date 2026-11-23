# Türkiye tax estimate & yearly holding P/L

The optional **Türkiye tax estimate** toggle in the sidebar applies a 2026 Turkish individual income tax scenario across **all strategies**—native 9Sig, SMA, Buy & Hold, Compounded Cash, all 48+ library strategies (including `#44` *NFCI veto, med stretch with SQQQ and med crash exit*, `#48` *NFCI veto + Turnaround Monday*, `#53`, etc.), and custom strategies that report holdings. It defaults to **off**. Assumptions persist in `localStorage` and travel with shared links; older shared links remain tax-off.

## Rules used (2026 GİB 332 Seri No'lu Tebliğ)

- **Taxpayer model:** Turkish-resident individual holding foreign ETFs, with no other declared income or personal deductions. Foreign securities sales realize taxable capital gains (*Değer Artış Kazancı*) with no general exemption.
- **2026 non-wage progressive schedule:** 15% up to ₺190,000; 20% to ₺400,000; 27% to ₺1,000,000; 35% to ₺5,300,000; 40% above ₺5,300,000. Brackets reset each calendar year and are converted once to USD using the **Current USD/TRY** input (approximating annual *Yeniden Değerleme Oranı* bracket adjustments over long backtests).
- **FIFO lots & TRY Yİ-ÜFE indexation (GVK mük. 81):**
  - Purchase costs include buy fees; sale proceeds are net of sell fees.
  - Each lot records its buy-month preceding Yİ-ÜFE index and buy-date USD/TRY rate.
  - On sale, cost basis in TRY is indexed by `PPI(sale_prev_month) / PPI(buy_prev_month)` **only when that increase is at least 10%**, then compared against TRY sale proceeds and converted back to sale-date USD.
  - Leaving both **Annual Yİ-ÜFE (%)** and **Annual USD/TRY change (%)** at `0%` gives a clean constant-real-USD (purchasing-power-parity) estimate. Setting both together (e.g., `35%` Yİ-ÜFE and `30%` USD/TRY depreciation) models the real 10% indexation cliff on short-term holds.
- **Same-year loss offset:** Capital losses offset same-year capital gains only, with no carryforward and no offset against cash interest.
- **Foreign cash interest:** Unwithheld foreign interest exceeding the USD equivalent of **₺22,000** joins the taxable base in full (declaration cliff, not a deduction).
- **Settlement timing:** Estimated tax is deducted on the last modeled trading day of each calendar year (and at the selected exit date for a partial final year). Cash pays first; holdings are sold proportionally if needed, including fees and same-year marginal tax gross-up. Unsold appreciation is **not** taxed. *(Actual Turkish filing/payment occurs in March and July of the following year, so Dec 31 deduction is slightly conservative.)*

## Strategy-aware yearly holding P/L

Every strategy panel also displays a **Yearly holding profit/loss** table showing close-to-close dollar P/L by calendar year plus an **All years** totals & `%` share row. Columns adapt automatically to each strategy's held funds (`TQQQ`, `SQQQ`, `SOXL`, `QQQ`, `SPY`, `GLD`, etc.) and break out active overlay rules (**Turnaround Monday**, **Month-end dip**, **Big days**) into their own columns so you can see exactly where gains originate.
