"""Tests for bench/scripts/optimization.py: python3 -m unittest discover -s bench/runner -p 'test_*.py'"""
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import optimization  # noqa: E402
from test_telemetry import MODEL, PRICING, SID, req  # noqa: E402

import telemetry  # noqa: E402


def attribute(*files, pricing=PRICING):
    with tempfile.TemporaryDirectory() as d:
        for name, entries in files:
            f = Path(d, "transcripts", "p", name)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("".join(json.dumps(e) + "\n" for e in entries))
        tel = telemetry.parse(d, "/work/repo", SID, pricing=pricing, sub="transcripts")
        return optimization.attribute(Path(d), pricing), tel["tokens_exact"]["all"]["list_cost_usd"]


class Attribution(unittest.TestCase):
    # A writes 1000 and leaves a 10-token tail; B re-reads it, adds A's output (60 thinking + 40 visible) and a
    # 50-token tool result; C re-reads all that and adds B's output and 30 more; D finds the cache expired.
    A = req("a", 0, 10, 1000, 0, 100, 0, 1000, thinking=60)
    B = req("b", 10, 5, 155, 1000, 20, 0, 155)
    C = req("c", 20, 5, 50, 1155, 10, 0, 50)
    D = req("d", 900, 5, 1265, 0, 10, 0, 1265)

    def test_parts_sum_to_list_cost(self):
        att, cost = attribute(("s.jsonl", [self.A, self.B, self.C, self.D]),
                              ("agent-x.jsonl", [req("x", 5, 3, 600, 400, 50, 600, 0, side=True)]))
        self.assertAlmostEqual(att["total_usd"], cost, places=9)
        self.assertAlmostEqual(sum(att["cost_usd"].values()), cost, places=9)
        self.assertEqual(att["threads"], 2)
        self.assertEqual(att["tokens"]["rewrite"], 1210 - 5)   # all of C's context but its uncached tail

    def test_thinking_is_billed_as_output_written_then_read(self):
        att, _ = attribute(("s.jsonl", [self.A, self.B, self.C]))
        write_b = (5 * 4 + 155 * 8) / 160                        # $/MTok of the tokens B sends uncached
        resend_c = 1155 * .2 + 5 * (5 * 4 + 50 * 8) / 55         # C: reads, plus B's tail sent again
        self.assertAlmostEqual(att["cost_usd"]["thinking"] * 1e6, 60 * 20 + 60 * write_b + 60 / 1160 * resend_c, places=6)
        self.assertEqual(att["cost_usd"]["rewrite"], 0)
        self.assertEqual(att["tokens"], {"initial": 1010, "thinking": 60, "visible": 40 + 20 + 10, "results": 50 + 30, "rewrite": 0})

    def test_unpriced_model_is_unavailable(self):
        self.assertIsNone(attribute(("s.jsonl", [self.A, req("h", 1, 10, 0, 0, 5, model="other-model")]))[0])
        self.assertIsNotNone(attribute(("s.jsonl", [self.A, req("z", 1, 0, 0, 0, 0, model="<synthetic>")]))[0])


class Stats(unittest.TestCase):
    def test_t_quantile(self):
        for df, t in ((2, 4.303), (5, 2.5706), (10, 2.2281), (35, 2.0301), (1000, 1.9623)):
            self.assertAlmostEqual(optimization.t975(df), t, delta=1e-3)

    def test_paired(self):
        p = optimization.paired([(1, .8), (2, 1.0), (1, 1.2), (3, 3)])
        self.assertEqual((p["lower"], p["higher"], p["equal"], p["sign_test_p"]), (2, 1, 1, 1.0))
        self.assertAlmostEqual(p["pooled_change_percent"], (6 / 7 - 1) * 100, places=4)
        geo = math.exp((math.log(.8) + math.log(.5) + math.log(1.2)) / 4) - 1
        self.assertAlmostEqual(p["geo_mean_change_percent"]["estimate"], geo * 100, places=4)
        lo, hi = p["geo_mean_change_percent"]["ci95"]
        self.assertLess(lo, geo * 100)
        self.assertGreater(hi, geo * 100)
        self.assertNotIn("geo_mean_change_percent", optimization.paired([(0, 1), (2, 1)]))   # zeros: differences only

    def test_objective(self):
        w = {"alpha_per_api_usd": 1, "beta_usd_per_second": .001, "gamma_usd_per_cpu_second": 0, "delta_usd_per_failure": 2}
        r = {"list_cost_usd": .5, "duration_seconds": 100, "cpu_seconds": None, "quality_score": 94, "status": "completed"}
        self.assertAlmostEqual(optimization.objective(r, w), .5 + .1 + 2 * .06)
        self.assertIsNone(optimization.objective(r, w | {"gamma_usd_per_cpu_second": 1e-5}))   # a weighted term is unavailable
        self.assertEqual(optimization.failure({"quality_score": None, "status": "timeout"}), 1.0)
        self.assertIsNone(optimization.failure({"quality_score": None, "status": "completed"}))

    def test_dist_counts_unavailable(self):
        self.assertEqual(optimization.dist([None, 2, 4]), {"n": 2, "mean": 3, "median": 3, "stdev": 1.414214,
                                                           "min": 2, "max": 4, "sum": 6, "unavailable": 1})
        self.assertEqual(optimization.dist([None]), {"n": 0, "unavailable": 1})


if __name__ == "__main__":
    unittest.main()
