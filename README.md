# 9sig.networthcast.com

Interactive backtester for the 9Sig and SMA-timing strategies, run over long-history price series for TQQQ, QLD, SSO, SPXL, SQQQ, SPXS, QQQ, SPY, UDOW, and EURL, with buy-and-hold benchmarks alongside.

Live: https://tqqq.networthcast.com

The **Türkiye tax estimate** toggle applies 2026 tax rules to native strategy simulations with editable USD/TRY and inflation assumptions. See [tax rules, sources and model limitations](TAXES.md).

## Updating price data

TSV files under `data/` hold ten ETF price series, three short-rate series, and the NFCI signal. See [data/README.md](data/README.md) for the format, the synthesis method, and its known biases.

```bash
# One-time setup (creates a venv and installs yfinance)
python3 -m venv .venv
.venv/bin/pip install yfinance

# Default: incremental refresh of the registered price TSVs
.venv/bin/python3 update_data.py
```

The default run pulls `period="max"` with `auto_adjust=True`, so every series is dividend- and split-adjusted on the same basis and comparisons between them stay fair. It replaces the post-IPO tail of each price file and preserves the committed pre-IPO synthesized history. SPXS/UDOW/EURL prefixes are rebased when Yahoo adjusts the first real close, keeping the join continuous. The short-rate files stay unchanged; the NFCI signal refreshes from FRED.

Price files: `synthetic-qqq.tsv`, `synthetic-qld.tsv`, `synthetic-tqqq.tsv`, `spy.tsv`, `synthetic-sso.tsv`, `synthetic-spxl.tsv`, `synthetic-sqqq.tsv`, `synthetic-spxs.tsv`, `synthetic-udow.tsv`, `synthetic-eurl.tsv`.

UDOW history starts in 1992; EURL starts in 1990. Both include pre-launch estimates and are available in native and custom strategies. EURL’s estimated section uses European fund proxies; see the [method and limitations](data/README.md#udow-and-eurl-reconstruction). Rebuild only these additions with `.venv/bin/python3 update_data.py --rebuild --tickers UDOW EURL`.

SPXS follows SQQQ’s inverse reconstruction method, with S&P 500 sources and its own calibrated coefficients. Its file starts in 1953, and real adjusted prices begin November 19, 2008. The real tail includes the former Russell 1000 mandate before June 29, 2012. See [SPXS methodology and limitations](data/README.md#spxs-the-sqqq-inverse-method-on-sp-history). Rebuild only SPXS with `.venv/bin/python3 update_data.py --rebuild-spxs`; reproduce its calibration with `--calibrate-spxs`.

The existing flags cover the rest:

- `--refresh-rates` re-pulls DFF and TB3MS from FRED and rewrites `fed-funds-effective.tsv`, `t-bill-3mo.tsv`, and `short-rates.tsv`. Nothing else refreshes these, so they drift stale until you run it.
- `--rebuild` regenerates every price TSV from scratch through the backward-synthesis pipeline. It needs a local `^ndx_d.csv` (Stooq) at the repo root to reach pre-1985 Nasdaq history; that file is not committed, and without it the rebuild stops where Yahoo's `^NDX` stops. Run it when adding a ticker or changing the synthesis.

## Automated refresh

`.github/workflows/update-data.yml` runs `update_data.py` in its default incremental mode and commits changed TSVs back to `main`.

- **Schedule**: hourly on weekdays, `30 13-22 * * 1-5`. That's ten fires, and a gate step drops any that falls outside 09:00–17:30 ET, leaving nine runs per trading day.
- **DST**: GitHub cron is fixed UTC. 13:30–22:30 UTC covers 09:30–18:30 ET in summer and 08:30–17:30 ET in winter, so the gate trims one fire off whichever end the current offset pushes out. Either way the day runs 09:30 to 17:30 ET.
- **Manual trigger**: `workflow_dispatch` runs it on demand from the Actions tab and skips the clock gate.
- **No-op on holidays**: the commit step checks `git diff --quiet -- 'data/*.tsv'` and exits cleanly when nothing changed.
- **Overlapping runs**: a `concurrency` group with `cancel-in-progress: false` queues a delayed run instead of killing it, and the push step rebases first, since two runs writing `data/*.tsv` would otherwise race.
- **Rate limits**: yfinance throttles shared CI IPs, and nine runs a day each pull `period="max"` for ten tickers. The refresh step retries once after 120s so a transient 429 lands as a later refresh rather than a failed run.
- **Permissions**: the workflow uses the default `GITHUB_TOKEN` with `contents: write`. If org-level settings block workflow pushes, flip *Settings → Actions → General → Workflow permissions* to "Read and write".

The **NFCI veto, med stretch with SQQQ and med crash exit** strategy has a
**Signal at t → trade at t+1 close** toggle under **Execution & costs**.
Off (default) uses the signal day's close. On executes each signal at the next
trading day's close, including the NFCI veto, stretch switches and crash exits.
The first signal waits one trading day; a signal on the final day remains unfilled.
With **One trade per day** enabled, fund switches sell first, then use the next
signal to decide what to buy on a later close. Fees and tax basis use execution-day
prices. Contributions still arrive on their scheduled dates; cash additions to an
unchanged holding and tax-settlement sales keep their existing timing.
