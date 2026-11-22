#!/usr/bin/env python3
"""
Regression and fork-safeguard check for Strategy #44:
"NFCI veto, med stretch with SQQQ and med crash exit".

Run this script before pushing any future sync from upstream:
    python tests/verify-nfci44-baseline.py

Checks:
1. CODE[44] in js/strategy-library-code.js matches the audited SHA-256 fingerprint
   and all 16 default parameter values are intact.
2. js/strategy-library.js preserves #44's full original name.
3. js/data.js buildNfciDaily preserves the exact 7-day NFCI publication lag.
4. Fork safeguards remain intact (no CNAME, no deploy-quotes-proxy.yml,
   QUOTES_PROXY disabled, Alpaca workflow step gated on secrets).
5. data/nfci.tsv is current (not frozen at 2026-08-28) and the locked historical
   trade sequences (2010-02-11..2025-12-31 and 2010-02-11..2026-11-20) match the
   audited golden baseline trade-for-trade.
"""

import bisect
import hashlib
import json
import math
import pathlib
import re
import sys
from datetime import datetime, timedelta

ROOT = pathlib.Path(__file__).resolve().parent.parent

EXPECTED_CODE44_SHA256 = 'd35cd970ceded618c78be415abcc5d1cfd4db6804494913e5e997e24c21cd894'
EXPECTED_TRADES_2010_2025_SHA256 = 'efd3567f004d7c14da6d44cd465cc47cbf3cb7603045809e4965b990ee4fc05c'
EXPECTED_TRADES_2010_2026_SHA256 = '0391346fae8794a150056d34ae3313d877ae30e6f0116f2e62b8742553164c40'

EXPECTED_DEFAULTS = {
    'asset': '"tqqq"',
    'stat': '"median"',
    'window': '250',
    'overPct': '55',
    'park': '"sqqq"',
    'crashStat': '"same"',
    'crashWindow': '0',
    'exitPct': '-28',
    'crashAsset': '"cash"',
    'slopeGate': '20',
    'belowGate': '10',
    'nfciTh': '0.4',
    'vetoEnd': '"cycle"',
    'splitDays': 'true',
    'cashRate': '4',
    'tradeCost': '0.02',
}


def load_tsv(path):
    rows = []
    for line in path.read_text(encoding='utf-8').splitlines()[1:]:
        parts = line.split('\t')
        if len(parts) < 2:
            continue
        m, d, y = parts[0].split(' ')[0].split('/')
        rows.append((f"{y}-{m.zfill(2)}-{d.zfill(2)}", float(parts[1])))
    return rows


def build_data():
    qqq = load_tsv(ROOT / 'data' / 'synthetic-qqq.tsv')
    tqqq = dict(load_tsv(ROOT / 'data' / 'synthetic-tqqq.tsv'))
    sqqq = dict(load_tsv(ROOT / 'data' / 'synthetic-sqqq.tsv'))
    nfci_rows = load_tsv(ROOT / 'data' / 'nfci.tsv')

    dates, t_arr, s_arr = [], [], []
    for dt, _ in qqq:
        tv = tqqq.get(dt)
        if tv is not None:
            dates.append(dt)
            t_arr.append(tv)
            s_arr.append(sqqq.get(dt, 0.0))

    avail = []
    for dt, val in nfci_rows:
        d = datetime.strptime(dt, '%Y-%m-%d') + timedelta(days=7)
        avail.append((d.strftime('%Y-%m-%d'), val))
    nfci_daily = []
    j = 0
    cur = float('nan')
    for dt in dates:
        while j < len(avail) and avail[j][0] <= dt:
            cur = avail[j][1]
            j += 1
        nfci_daily.append(cur)

    return {
        'dates': dates,
        'tqqq': t_arr,
        'sqqq': s_arr,
        'nfci': nfci_daily,
        'nfci_last_date': nfci_rows[-1][0],
        'nfci_last_val': nfci_rows[-1][1],
    }


class RollingMedian:
    def __init__(self):
        self.win = []

    def ins(self, v):
        bisect.insort_left(self.win, v)

    def rem(self, v):
        k = bisect.bisect_left(self.win, v)
        if k < len(self.win) and self.win[k] == v:
            self.win.pop(k)

    def median(self):
        n = len(self.win)
        if n == 0:
            return 0.0
        return self.win[(n - 1) >> 1] if (n % 2) else (self.win[n // 2 - 1] + self.win[n // 2]) / 2.0


def run_strategy_44(data, start_date, end_date=None):
    dates = data['dates']
    px = data['tqqq']
    sqqq = data['sqqq']
    nfci_arr = data['nfci']

    entry_idx = next(i for i, d in enumerate(dates) if d >= start_date)
    end_idx = len(dates) - 1 if end_date is None else max(i for i, d in enumerate(dates) if d <= end_date)

    W = 250
    over = 0.55
    exitB = -0.28
    cost = 0.0002
    day_rate = (1.0 + 0.04) ** (1.0 / 252.0) - 1.0
    nfci_th = 0.4
    slope_gate = 20.0
    below_gate = 10

    initial_entry = 100000.0
    start_idx = max(0, entry_idx - 3 * W)

    roll_m = RollingMedian()
    warm_from = max(0, start_idx - W + 1)
    for k in range(warm_from, start_idx):
        if px[k] > 0:
            roll_m.ins(px[k])

    pre_c = [0.0] * 63
    pre = RollingMedian()
    pf = max(0, start_idx - 63 - W + 1)
    for k in range(pf, start_idx - 63):
        if k >= 0 and px[k] > 0:
            pre.ins(px[k])
    for j in range(63):
        k = start_idx - 63 + j
        if k >= 0 and px[k] > 0:
            pre.ins(px[k])
        drop_k = k - W
        if drop_k >= pf and drop_k >= 0 and px[drop_k] > 0:
            pre.rem(px[drop_k])
        pre_c[j] = pre.median() if k >= 0 else 0.0

    hist_c = [0.0] * 64
    below_c = 0
    veto_active = False
    cycle_exit = False
    prev_above = False
    veto_on = False

    cash = initial_entry
    shares = 0.0
    held = 'cash'
    state = 'normal'

    def price_of(asset, idx):
        if asset == 'cash':
            return 0.0
        return px[idx] if asset == 'tqqq' else sqqq[idx]

    trades = []
    peak_val = 0.0
    max_dd = 0.0
    final_val = 0.0
    last_info = {}

    for i in range(start_idx, end_idx + 1):
        if px[i] > 0:
            roll_m.ins(px[i])
        drop = i - W
        if drop >= warm_from and px[drop] > 0:
            roll_m.rem(px[drop])
        med = roll_m.median()
        sig = px[i]
        above = (sig / med - 1.0) if (med > 0 and sig > 0) else 0.0
        day_n = i - start_idx
        prev_c = hist_c[(day_n - 63) % 64] if day_n >= 63 else pre_c[day_n]
        slope_c = ((med / prev_c) ** 4 - 1.0) * 100.0 if (prev_c > 0 and med > 0) else 0.0
        hist_c[day_n % 64] = med
        below_c = (below_c + 1) if (med > 0 and sig > 0 and sig < med) else 0
        nf_now = nfci_arr[i]

        if held == 'cash':
            cash *= (1.0 + day_rate)

        action = 'hold'
        if med > 0 and sig > 0:
            p_over = med * (1.0 + over)
            p_exit = med * (1.0 + exitB)
            if state in ('normal', 'over'):
                if sig > p_over:
                    state = 'over'
                elif sig < p_exit and slope_c < slope_gate and below_c >= below_gate:
                    state = 'crashCash'
                else:
                    state = 'normal'
            elif sig > p_exit:
                state = 'normal'

            nf_above = (not math.isnan(nf_now)) and (nf_now > nfci_th)
            if nf_above and not prev_above:
                veto_active = True
                cycle_exit = False
            if not nf_above:
                veto_active = False
            if veto_active:
                if state == 'crashCash':
                    cycle_exit = True
                elif cycle_exit:
                    veto_active = False
            veto_on = veto_active
            prev_above = nf_above

            want = 'tqqq' if state == 'normal' else ('sqqq' if state == 'over' else 'cash')
            if veto_on:
                want = 'cash'
            if want != held and held != 'cash' and want != 'cash':
                want = 'cash'

            if want != held:
                old_px = price_of(held, i)
                if held != 'cash' and old_px > 0:
                    gross = shares * old_px
                    cash += gross - gross * cost
                    shares = 0.0
                new_px = price_of(want, i)
                if want == 'cash' or new_px > 0:
                    if want != 'cash':
                        shares = (cash - cash * cost) / new_px
                        cash = 0.0
                    action = 'buy' if held == 'cash' else ('sell' if want == 'cash' else 'switch')
                    held = want

        if i < entry_idx:
            continue
        if i == entry_idx:
            px_e = price_of(held, i)
            in_fund = shares * px_e if (held != 'cash' and px_e > 0) else 0.0
            total = in_fund + cash
            scale = initial_entry / total if total > 0 else 0.0
            fee = in_fund * scale * cost
            shares = (in_fund * scale - fee) / px_e if px_e > 0 else 0.0
            cash *= scale
            action = 'start'

        hp = price_of(held, i)
        val = shares * hp + cash
        if val > peak_val:
            peak_val = val
        dd = (peak_val - val) / peak_val if peak_val > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
        if action in ('buy', 'sell', 'switch'):
            trades.append([dates[i], action, held])
        if i == end_idx:
            final_val = val
            last_info = {
                'date': dates[i],
                'held': held,
                'state': state,
                'veto_on': veto_on,
                'tqqq': round(px[i], 4),
                'med250': round(med, 4),
                'above_pct': round(above * 100.0, 2),
                'nfci': None if math.isnan(nf_now) else round(nf_now, 4),
                'below_c': below_c,
                'slope_c': round(slope_c, 2),
            }

    years = (datetime.strptime(dates[end_idx], '%Y-%m-%d') - datetime.strptime(dates[entry_idx], '%Y-%m-%d')).days / 365.25
    cagr = ((final_val / initial_entry) ** (1.0 / years) - 1.0) * 100.0 if years > 0 else 0.0
    trade_hash = hashlib.sha256(json.dumps(trades, separators=(',', ':')).encode('utf-8')).hexdigest()
    return {
        'trades': trades,
        'trade_hash': trade_hash,
        'cagr': round(cagr, 2),
        'max_dd': round(max_dd * 100.0, 2),
        'last': last_info,
    }


def check_source_invariants():
    errors = []

    code_src = (ROOT / 'js' / 'strategy-library-code.js').read_text(encoding='utf-8').replace('\r\n', '\n')
    start = code_src.index('CODE[44] = ')
    end = code_src.index('\n\n// #45', start)
    block = code_src[start:end]
    sha = hashlib.sha256(block.encode('utf-8')).hexdigest()
    if sha != EXPECTED_CODE44_SHA256:
        errors.append(
            f"CODE[44] source changed! Expected sha256 {EXPECTED_CODE44_SHA256}, got {sha}. "
            "Audit every line of CODE[44] before updating EXPECTED_CODE44_SHA256."
        )

    for param_id, expected_default in EXPECTED_DEFAULTS.items():
        pat = rf'id:\s*"{re.escape(param_id)}"[^\n]*default:\s*{re.escape(expected_default)}(?=[,\s}}])'
        if not re.search(pat, block):
            errors.append(f"CODE[44] default mismatch for param '{param_id}' (expected {expected_default})")

    lib_src = (ROOT / 'js' / 'strategy-library.js').read_text(encoding='utf-8')
    if "{ n: 44, name: 'NFCI veto, med stretch with SQQQ and med crash exit'" not in lib_src:
        errors.append("js/strategy-library.js entry #44 no longer keeps its full original name")

    data_src = (ROOT / 'js' / 'data.js').read_text(encoding='utf-8')
    if "t.setUTCDate(t.getUTCDate() + 7);" not in data_src:
        errors.append("js/data.js buildNfciDaily 7-day publication lag missing or changed")
    if "const QUOTES_PROXY = '';" not in data_src:
        errors.append("js/data.js QUOTES_PROXY is not disabled for this fork")

    intraday_src = (ROOT / 'experiments' / 'tqqq-intraday.html').read_text(encoding='utf-8')
    if "const QUOTES_PROXY = '';" not in intraday_src:
        errors.append("experiments/tqqq-intraday.html QUOTES_PROXY is not disabled for this fork")

    if (ROOT / 'CNAME').exists():
        errors.append("CNAME exists on disk (must stay deleted on fork)")
    if (ROOT / '.github' / 'workflows' / 'deploy-quotes-proxy.yml').exists():
        errors.append(".github/workflows/deploy-quotes-proxy.yml exists (must stay removed on fork)")

    wf_src = (ROOT / '.github' / 'workflows' / 'update-data.yml').read_text(encoding='utf-8')
    if 'if [ -z "$ALPACA_API_KEY" ]' not in wf_src:
        errors.append(".github/workflows/update-data.yml Alpaca step is not gated on secrets")

    return errors


def main():
    errors = check_source_invariants()

    data = build_data()
    if data['nfci_last_date'] < '2026-11-13':
        errors.append(f"data/nfci.tsv appears stale: last date is {data['nfci_last_date']}")

    r25 = run_strategy_44(data, '2010-02-11', '2025-12-31')
    if r25['trade_hash'] != EXPECTED_TRADES_2010_2025_SHA256:
        errors.append(
            f"2010-2025 trade sequence changed! count={len(r25['trades'])}, "
            f"hash={r25['trade_hash']} (expected {EXPECTED_TRADES_2010_2025_SHA256})"
        )
    if abs(r25['cagr'] - 82.91) > 0.05 or abs(r25['max_dd'] - 60.17) > 0.05:
        errors.append(f"2010-2025 metrics drifted: CAGR={r25['cagr']}% DD={r25['max_dd']}%")

    r26 = run_strategy_44(data, '2010-02-11', '2026-11-20')
    if r26['trade_hash'] != EXPECTED_TRADES_2010_2026_SHA256:
        errors.append(
            f"2010-2026-11-20 trade sequence changed! count={len(r26['trades'])}, "
            f"hash={r26['trade_hash']} (expected {EXPECTED_TRADES_2010_2026_SHA256})"
        )

    latest = run_strategy_44(data, '2010-02-11')

    if errors:
        print("FAIL — Strategy #44 / Fork Safeguard Check FAILED:")
        for e in errors:
            print("  -", e)
        sys.exit(1)

    print("PASS — All Strategy #44 & Fork Safeguard checks passed!")
    print(f"  CODE[44] sha256   : {EXPECTED_CODE44_SHA256}")
    print(f"  2010-2025 baseline: {len(r25['trades'])} trades, CAGR {r25['cagr']}%, Max DD {r25['max_dd']}% (exact trade hash match)")
    print(f"  2010-2026 baseline: {len(r26['trades'])} trades, CAGR {r26['cagr']}%, Max DD {r26['max_dd']}% (exact trade hash match)")
    print(f"  NFCI latest row   : {data['nfci_last_date']} ({data['nfci_last_val']:+.4f})")
    print(f"  Live signal ({latest['last']['date']}): held={latest['last']['held'].upper()} "
          f"state={latest['last']['state']} veto={latest['last']['veto_on']} "
          f"TQQQ=${latest['last']['tqqq']} vs med250=${latest['last']['med250']} "
          f"({latest['last']['above_pct']:+.2f}%) below={latest['last']['below_c']}d "
          f"slope={latest['last']['slope_c']:+.1f}%/yr NFCI={latest['last']['nfci']:+.4f}")


if __name__ == '__main__':
    main()
