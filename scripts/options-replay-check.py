import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare-options-replay.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class SolverTests(unittest.TestCase):
    def test_no_submillisecond_underlying_lookahead(self):
        self.assertEqual(prepare.stock_index([999999,1000000,1000001],1000),1)
        self.assertEqual(prepare.stock_index([1000001],1000),-1)

    def test_known_zero_carry_price_and_parity(self):
        call, delta = prepare.price_delta(100, 100, 1, .2, 'call')
        put, pdelta = prepare.price_delta(100, 100, 1, .2, 'put')
        self.assertAlmostEqual(call, 7.9655674554, places=8)
        self.assertAlmostEqual(call, put, places=12)
        self.assertAlmostEqual(delta - pdelta, 1)
        self.assertAlmostEqual(prepare.implied(100, 100, 1, call, 'call')[0], .2, places=10)

    def test_invalid_prices_and_expiry(self):
        self.assertIsNone(prepare.implied(110, 100, 1, 9, 'call'))
        self.assertIsNone(prepare.implied(100, 100, 0, 5, 'call'))
        self.assertIsNone(prepare.implied(100, 100, 1, 101, 'put'))

    def test_bid_ask_implies_an_interval(self):
        lo = prepare.implied(100, 100, .02, 2, 'call')[0]
        hi = prepare.implied(100, 100, .02, 3, 'call')[0]
        self.assertLess(lo, hi)


unittest.main()
