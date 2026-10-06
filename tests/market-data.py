"""Offline updater regressions: .venv/bin/python3 tests/market-data.py"""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
# Load the updater's helper section without executing its command-line entry.
ns = {'__file__': str(ROOT / 'update_data.py')}
exec(compile((ROOT / 'update_data.py').read_text().split('# === CLI ===')[0], str(ROOT / 'update_data.py'), 'exec'), ns)


def frame(dates, prices):
    return pd.DataFrame({'Close': prices}, index=pd.to_datetime(dates))


class MarketDataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / 'data'
        self.data.mkdir()
        self.path = self.data / 'synthetic-eurl.tsv'
        self.patch = patch.dict(ns, basedir=self.tmp.name)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.real = frame(['2014-01-22', '2014-01-23'], [100, 102])
        self.sources = {'EURL': self.real,
                        'VGK': frame(['2005-03-10', '2014-01-22'], [10, 11]),
                        'VEURX': frame(['1990-06-18', '2005-03-10'], [10, 12])}
        ns['write_rate_tsv'](self.data / 'short-rates.tsv', [(pd.Timestamp(d), 5) for d in ['1990-06-18', '2005-03-10', '2014-01-22']])

    def rebuild(self):
        with patch.dict(ns, fetch=lambda ticker, **kwargs: self.sources[ticker].copy()), contextlib.redirect_stdout(io.StringIO()):
            ns['rebuild_added_etf']('EURL', 'synthetic-eurl.tsv')

    def test_chained_returns_financing_and_real_tail(self):
        self.rebuild()
        rows = ns['read_price_tsv'](self.path)
        drag = (2 * (0.05 + 0.005) + 0.0104) / 252
        self.assertAlmostEqual(rows[1][1], 100 / (1 + 3 * 0.1 - drag), places=8)
        self.assertAlmostEqual(rows[0][1], rows[1][1] / (1 + 3 * 0.2 - drag), places=8)
        self.assertEqual([v for _, v in rows[2:]], [100, 102])
        self.assertEqual(len(rows), len(dict(rows)))

    def test_failed_source_does_not_overwrite(self):
        self.path.write_text('existing data')
        self.sources['VGK'] = pd.DataFrame()
        with self.assertRaises(ValueError):
            self.rebuild()
        self.assertEqual(self.path.read_text(), 'existing data')

    def test_missing_anchor_does_not_overwrite(self):
        self.path.write_text('existing data')
        self.sources['VGK'] = frame(['2005-03-10', '2014-01-21'], [10, 11])
        with self.assertRaisesRegex(ValueError, 'missing anchor'):
            self.rebuild()
        self.assertEqual(self.path.read_text(), 'existing data')

    def test_incremental_rebases_prefix_after_adjustment(self):
        self.rebuild()
        before = ns['read_price_tsv'](self.path)
        fresh = frame(['2014-01-22', '2014-01-23', '2014-01-24'], [50, 51, 52])
        with patch.dict(ns, tickers=[('EURL', self.path.name)], fetch=lambda ticker: fresh,
                        fetch_fred=lambda *args, **kwargs: []), contextlib.redirect_stdout(io.StringIO()):
            ns['incremental_refresh']()
            once = self.path.read_bytes()
            ns['incremental_refresh']()
        after = ns['read_price_tsv'](self.path)
        self.assertAlmostEqual(after[0][1], before[0][1] / 2, places=8)
        self.assertAlmostEqual(after[1][1], before[1][1] / 2, places=8)
        self.assertEqual(after[-1][1], 52)
        self.assertEqual(once, self.path.read_bytes())


if __name__ == '__main__':
    unittest.main()
