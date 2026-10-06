"""Offline inverse-model/updater checks: .venv/bin/python3 tests/spxs-data.py"""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
ns = {'__file__': str(ROOT / 'update_data.py')}
exec(compile((ROOT / 'update_data.py').read_text().split('# === CLI ===')[0], 'update_data.py', 'exec'), ns)


def frame(dates, prices):
    return pd.DataFrame({'Close': prices}, index=pd.to_datetime(dates))


class SPXSTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'data'
        self.data.mkdir()
        self.path = self.data / 'synthetic-spxs.tsv'
        self.sources = {
            'SPXS': frame(['2008-11-19', '2008-11-20'], [70, 72]),
            '^SP500TR': frame(['1988-01-04', '2008-11-19'], [100, 110]),
            '^GSPC': frame(['1953-01-02', '1988-01-04', '2008-11-19'], [100, 90, 99]),
        }
        self.patch = patch.dict(ns, basedir=self.temp.name,
                               fetch=lambda ticker: self.sources[ticker].copy())
        self.patch.start()
        self.addCleanup(self.patch.stop)
        ns['write_rate_tsv'](self.data / 'short-rates.tsv', [
            (pd.Timestamp('1953-01-02'), 5), (pd.Timestamp('1988-01-04'), 6)])

    def build(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return ns['build_spxs_history']()

    def test_inverse_phases_use_prior_rate_and_keep_real_tail(self):
        prefix, real = self.build()
        cash, drag = ns['SPXS_CASH_MULTIPLE'], ns['SPXS_DRAG_DAILY']
        # The total-return index rises 10%: the inverse loses about 30%.
        expected_1988 = 70 / (0.7 + cash * 0.06 / 252 + drag)
        # The earlier price-only index falls 10%: the inverse gains about 30%.
        expected_1953 = expected_1988 / (1.3 + cash * 0.05 / 252 + drag)
        self.assertAlmostEqual(prefix[1][1], expected_1988, places=10)
        self.assertAlmostEqual(prefix[0][1], expected_1953, places=10)
        ns['write_price_tsv'](self.path, prefix, real)
        rows = ns['read_price_tsv'](self.path)
        self.assertEqual([d for d, _ in rows], list(pd.to_datetime([
            '1953-01-02', '1988-01-04', '2008-11-19', '2008-11-20'])))
        self.assertEqual([c for _, c in rows[-2:]], [70, 72])

    def test_inverse_collateral_earns_interest(self):
        d1, d2 = pd.to_datetime(['2000-01-03', '2000-01-04'])
        _, prefix = ns['walk_backward_inverse']([(d1, 100), (d2, 100)], d2, 100,
            {d1: 5}, leverage=3, cash_multiple=4, drag_daily=0)
        self.assertAlmostEqual(100 / prefix[0][1] - 1, 4 * 0.05 / 252, places=12)

    def test_sqqq_defaults_are_unchanged(self):
        d1, d2 = pd.to_datetime(['2000-01-03', '2000-01-04'])
        _, prefix = ns['walk_backward_inverse']([(d1, 100), (d2, 110)], d2, 70, {d1: 5})
        self.assertAlmostEqual(prefix[0][1], 70 / (0.7 + 4.028 * 0.05 / 252 - 6.099e-05), places=10)

    def test_bad_sources_and_missing_rates_do_not_overwrite(self):
        self.path.write_text('keep existing history')
        cases = [('^SP500TR', pd.DataFrame()),
                 ('^SP500TR', frame(['1988-01-04', '2008-11-18'], [100, 110])),
                 ('^GSPC', frame(['1988-01-04'], [100])),
                 ('SPXS', frame(['2008-11-19'], [float('nan')])),
                 ('SPXS', frame(['2008-11-19', '2008-11-19'], [70, 71])),
                 ('^SP500TR', frame(['1988-01-04', '2008-11-19'], [100, 200]))]
        for ticker, bad in cases:
            with self.subTest(ticker=ticker), patch.dict(self.sources, {ticker: bad}):
                with self.assertRaises(ValueError):
                    self.build()
                self.assertEqual(self.path.read_text(), 'keep existing history')
        (self.data / 'short-rates.tsv').unlink()
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual(self.path.read_text(), 'keep existing history')

    def test_incremental_prefix_matches_sqqq_behavior(self):
        prefix, real = self.build()
        for ticker in ['spxs', 'sqqq']:
            ns['write_price_tsv'](self.data / f'synthetic-{ticker}.tsv', prefix, real)
        before = self.path.read_text().splitlines()[:3]
        fresh = frame(['2008-11-19', '2008-11-20', '2008-11-21'], [70, 72, 74])
        targets = [('SPXS', 'synthetic-spxs.tsv'), ('SQQQ', 'synthetic-sqqq.tsv')]
        with patch.dict(ns, tickers=targets, fetch=lambda ticker: fresh,
                        fetch_fred=lambda *a, **kw: []), contextlib.redirect_stdout(io.StringIO()):
            ns['incremental_refresh']()
            once = self.path.read_bytes()
            ns['incremental_refresh']()
        self.assertEqual(self.path.read_text().splitlines()[:3], before)
        self.assertEqual(ns['read_price_tsv'](self.path)[-1][1], 74)
        self.assertEqual(once, self.path.read_bytes())
        self.assertEqual(once, (self.data / 'synthetic-sqqq.tsv').read_bytes())

    def test_split_adjustment_preserves_synthetic_returns_and_join(self):
        prefix, real = self.build()
        ns['write_price_tsv'](self.path, prefix, real)
        before = ns['read_price_tsv'](self.path)
        fresh = frame(['2008-11-19', '2008-11-20', '2008-11-21'], [700, 720, 740])
        with patch.dict(ns, tickers=[('SPXS', self.path.name)], fetch=lambda ticker: fresh,
                        fetch_fred=lambda *a, **kw: []), contextlib.redirect_stdout(io.StringIO()):
            ns['incremental_refresh']()
            once = self.path.read_bytes()
            ns['incremental_refresh']()
        after = ns['read_price_tsv'](self.path)
        for (_, old), (_, new) in zip(before, after):
            self.assertAlmostEqual(new / old, 10, places=8)
        self.assertAlmostEqual(after[2][1] / after[1][1], before[2][1] / before[1][1], places=10)
        self.assertEqual(after[-1][1], 740)
        self.assertEqual(self.path.read_bytes(), once)

    def test_invalid_incremental_download_does_not_overwrite(self):
        prefix, real = self.build()
        ns['write_price_tsv'](self.path, prefix, real)
        before = self.path.read_bytes()
        fresh = frame(['2008-11-19', '2008-11-20'], [70, float('nan')])
        with patch.dict(ns, tickers=[('SPXS', self.path.name)], fetch=lambda ticker: fresh):
            with self.assertRaises(ValueError):
                ns['incremental_refresh']()
        self.assertEqual(self.path.read_bytes(), before)

    def test_all_existing_and_new_funds_are_registered(self):
        self.assertEqual({t for t, _ in ns['tickers']},
                         {'QQQ', 'QLD', 'TQQQ', 'SPY', 'SSO', 'SPXL', 'SQQQ', 'SPXS', 'UDOW', 'EURL'})


if __name__ == '__main__':
    unittest.main()
