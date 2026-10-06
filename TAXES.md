# Türkiye tax estimate

The optional **Türkiye tax estimate** button applies a current-law scenario to the native 9Sig, SMA, Buy & Hold and Compounded Cash simulations, including their saved parameter variants, previews and analytics. It defaults to off. Assumptions persist locally and travel with shared links; older shared links remain tax-off.

## Rules used

Assume a Turkish-resident individual holding foreign ETFs, with no other declared income or personal deductions. Foreign securities sales are taxable capital gains, with no general capital-gain exemption. See the [GİB capital-gains guide, sections 1.1.1 and 1.3](https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv%2Ffileadmin%2Fbeyannamerehberi%2F2026%2FDiger_Kazanc_ve_Iratlar_2026.pdf).

The 2026 **non-wage** progressive schedule applies to every simulated year: 15% up to ₺190,000; 20% to ₺400,000; 27% to ₺1,000,000; 35% to ₺5,300,000; 40% above that. See [GİB's 2026 tariff](https://usak.gib.gov.tr/vergi-konulari/1_bireysel/11_ucret_geliri/11). Brackets reset each calendar year; this does not reproduce historical brackets or older tax regimes.

The simplified model keeps purchases, proceeds, gains and payments in USD. It uses FIFO lots, purchase costs including buy fees, and sale proceeds net of sell fees. Costs are indexed using the ratio of the months preceding purchase and sale when the increase is at least 10%. See [GİB's indexation explanation](https://intvrg.gib.gov.tr/hazirbeyan/faqMenkul.html). Same-year capital losses offset capital gains, with no carryforward or offset against cash interest. See the [foreign-securities section of Garanti BBVA's tax guide](https://www.garantibbva.com.tr/content/dam/public-website/pdf/yatirim/vergilendirme/mk-vergilendirme-2026.pdf).

Cash interest is modeled as foreign interest without Turkish withholding. If annual interest exceeds the current USD equivalent of ₺22,000, its entire amount joins the taxable base; this threshold is not a deduction. See [GİB's investment-income guidance](https://gib.gov.tr/vergi-konulari/1_bireysel/10_menkul_sermaye_iradi/10).

## Scenario assumptions

- Current USD/TRY defaults to **40**, a scenario input, not a live quoted exchange rate. It is used only once to convert the Turkish lira tax brackets and interest declaration threshold to USD. Portfolio transactions are never converted to TRY.
- Yİ-ÜFE defaults to **0%** annual growth. Its hypothetical monthly index compounds at the corresponding monthly rate. Historical TÜİK indices are not bundled.
- Tax is deducted on the last modeled trading day of each calendar year. A final partial year's liability is also deducted at the selected exit. Holdings remaining at exit are **not** deemed sold.
- Cash funds tax first; holdings are sold if needed. These sales incur the strategy's transaction costs and realize gains/losses in the same year, so their additional tax is included. Negative residual balances represent unfunded tax liability when the portfolio is exhausted.
- For 9Sig, the parking sleeve funds tax before the primary fund. For SMA, holdings are visited in asset order. These are modeling choices. Settlement delays are bypassed for required tax sales; SMA's next buy observes the resulting sale date.
- Deducting tax at year-end follows the requested backtest convention. Actual filing/payment generally occurs the following March/July, as described in the [GİB guide, sections 5 and 7](https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv%2Ffileadmin%2Fbeyannamerehberi%2F2026%2FDiger_Kazanc_ve_Iratlar_2026.pdf).

## Limits

Existing prices include reinvested dividends and split adjustments. They are used as approximate trade prices; separate dividend income, its tax and foreign withholding credits cannot be reconstructed. No filing charges, other income, personal exemptions or deductions are included. Simulations are separate hypothetical portfolios, not one combined taxpayer return. Contributions are not income, and unsold appreciation is not taxed.

The **NFCI veto, med stretch with SQQQ and med crash exit** strategy records its TQQQ/SQQQ/cash trades, FIFO lots, trading costs and cash interest, so it uses the same tax engine and shows an annual breakdown in its strategy panel. Existing saved copies of the library strategy automatically run the current tax-aware implementation while retaining their saved parameter values.

Other custom and code-based library strategies provide arbitrary value series rather than a complete trade ledger. Their results remain explicitly labeled **pre-tax** while the toggle is on. Native parameter-based library presets use the native tax engine. Compounded Cash is treated as foreign interest, not investment sales.

Engine results expose `taxPayments`, `baselineTaxPayments` and `bhTaxPayments` with payment dates, separate USD realized profits and losses, net USD sales gains, USD interest, taxable income and USD tax. SMA logs also include `TAX` events. The chart shows cumulative reference-strategy taxes in USD, and the NFCI strategy panel shows the annual calculation table. Sell and switch rows in the NFCI transaction log show the execution price of the asset sold, including a sale made to fund tax.

Run `node tests/sim.cjs` and `node tests/tax.cjs` for numerical checks. With Playwright/Chromium installed and a static server on port 8753, run `node tests/tax-ui.cjs` for toggle, persistence and sharing checks, and `node tests/suite.cjs` for the existing browser suite.
