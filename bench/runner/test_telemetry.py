"""Tests for the measurement pipeline: python3 -m unittest discover -s bench/runner -p 'test_*.py'"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bench  # noqa: E402
import isolation  # noqa: E402
import telemetry  # noqa: E402

MODEL = "claude-opus-5-5"
PRICING = {"reference_model": MODEL,
           "usd_per_mtok": {MODEL: {"input": 4, "cache_write_5m": 5, "cache_write_1h": 8, "cache_read": 0.2, "output": 20}}}
SID = "main-session"


def req(rid, ts, i, cw, cr, o, w5=None, w1=None, model=MODEL, thinking=0, side=False):
    u = {"input_tokens": i, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr, "output_tokens": o,
         "output_tokens_details": {"thinking_tokens": thinking}}
    if w5 is not None:
        u["cache_creation"] = {"ephemeral_5m_input_tokens": w5, "ephemeral_1h_input_tokens": w1}
    return {"type": "assistant", "requestId": rid, "sessionId": SID, "isSidechain": side,
            "timestamp": f"2026-10-09T10:{ts // 60:02d}:{ts % 60:02d}Z", "message": {"model": model, "usage": u, "content": []}}


def parse(*files, pricing=PRICING):
    with tempfile.TemporaryDirectory() as d:
        for name, entries in files:
            f = Path(d, "projects", "p", name)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("".join(json.dumps(e) + "\n" for e in entries))
        return telemetry.parse(d, "/work/repo", SID, pricing=pricing)


class Cost(unittest.TestCase):
    def setUp(self):
        a = req("a", 0, 10, 1000, 0, 100, 0, 1000, thinking=60)
        self.tel = parse(("s.jsonl", [
            req("a", 0, 10, 1000, 0, 7, 0, 1000, thinking=5), a, a,   # one streamed request: counted once, final output
            req("b", 10, 5, 200, 1010, 50, 200, 0),
            req("c", 20, 1, 300, 1215, 10),         # no TTL split: priced as a 5-minute write
        ]))
        self.all = self.tel["tokens_exact"]["all"]

    def test_ttl_split_and_list_cost(self):
        self.assertEqual(self.all["requests"], 3)
        self.assertEqual((self.all["cache_creation_5m_input_tokens"], self.all["cache_creation_1h_input_tokens"],
                          self.all["cache_creation_ttl_unknown_input_tokens"]), (200, 1000, 300))
        cost = (10 * 4 + 1000 * 8 + 100 * 20) + (5 * 4 + 200 * 5 + 1010 * .2 + 50 * 20) + (1 * 4 + 300 * 5 + 1215 * .2 + 10 * 20)
        self.assertAlmostEqual(self.all["list_cost_usd"], cost / 1e6, places=6)
        self.assertEqual(self.all["price_weighted_tokens"], round(cost / 4))
        self.assertEqual(self.all["input_equivalent_tokens"], round(16 + 1.25 * 1500 + .1 * 2225 + 5 * 160))  # legacy, unchanged

    def test_first_request_and_summary(self):
        first = self.tel["tokens_exact"]["first_request"]
        self.assertAlmostEqual(first["list_cost_usd"], (10 * 4 + 1000 * 8 + 100 * 20) / 1e6, places=6)
        s = telemetry.summary(self.tel)
        self.assertEqual((s["list_cost_usd"], s["thinking_tokens"], s["first_request_thinking_tokens"]),
                         (self.all["list_cost_usd"], 60, 60))

    def test_summary_of_old_telemetry_is_unavailable(self):
        old = {"tokens_exact": {"all": {"total_tokens": 5}}, "hooks": {"count": 1}}
        self.assertTrue(all(v is None for v in telemetry.summary(old).values()))

    def test_unpriced_model_is_unavailable(self):
        tel = parse(("s.jsonl", [req("a", 0, 10, 0, 0, 5), req("h", 1, 10, 0, 0, 5, model="other-model")]))
        self.assertIsNone(tel["tokens_exact"]["all"]["list_cost_usd"])
        self.assertIsNotNone(tel["tokens_exact"]["by_model"][MODEL]["list_cost_usd"])
        self.assertIsNone(parse(("s.jsonl", [req("a", 0, 10, 0, 0, 5)]), pricing=None)["tokens_exact"]["all"]["list_cost_usd"])

    def test_empty_synthetic_entry_costs_nothing(self):
        tel = parse(("s.jsonl", [req("a", 0, 10, 0, 0, 5), req("z", 1, 0, 0, 0, 0, model="<synthetic>")]))
        self.assertAlmostEqual(tel["tokens_exact"]["all"]["list_cost_usd"], (40 + 100) / 1e6, places=6)


class CacheStats(unittest.TestCase):
    def test_miss_versus_shrunk_context(self):
        c = parse(("s.jsonl", [
            req("1", 0, 10, 5000, 0, 10, 0, 5000),
            req("2", 30, 10, 4500, 1000, 10, 0, 4500),   # context grew, read only 1000 of 5000 cached: miss
            req("3", 60, 10, 2000, 0, 10, 0, 2000),      # compaction: context shrank, not a miss
            req("4", 90, 10, 100, 1900, 10, 0, 100),     # read 1900 of 2010 cached: within tolerance
        ]))["cache"]
        self.assertEqual((c["miss_requests"], c["miss_rewrite_tokens"]), (1, 5000 + 10 - 1000 - 10))

    def test_idle_gaps_per_thread(self):
        c = parse(("s.jsonl", [req("1", 0, 1, 0, 0, 1), req("2", 100, 1, 0, 0, 1), req("3", 500, 1, 0, 0, 1)]),
                  ("agent.jsonl", [req("x", 1500, 1, 0, 0, 1, side=True)]))["cache"]
        self.assertEqual((c["idle_seconds_max"], c["idle_gaps_over_300s"], c["transitions"]), (400.0, 1, 2))


class Hooks(unittest.TestCase):
    def test_durations_include_stop_summary(self):
        h = parse(("s.jsonl", [
            {"type": "attachment", "attachment": {"type": "hook_success", "hookEvent": "SessionStart", "durationMs": "62", "stdout": ""}},
            {"type": "system", "subtype": "stop_hook_summary", "hookInfos": [{"durationMs": 30}, {"durationMs": 8}]},
        ]))["hooks"]
        self.assertEqual((h["duration_ms_total"], h["duration_ms_by_event"]), (100, {"SessionStart": 62, "Stop": 38}))


class Runner(unittest.TestCase):
    def test_changed_fields(self):
        old = {"a": 1, "b": {"c": 2, "d": 3}, "e": 4}
        new = {"a": 1, "b": {"c": 2, "d": 5, "x": 1}, "f": 0}
        self.assertEqual(bench.changed_fields(old, new), ["b.d", "e"])
        self.assertEqual(bench.changed_fields(old, {**old, "new": 1}), [])

    def test_reap_peak_rss_and_exit_code(self):
        p = subprocess.Popen([sys.executable, "-c", "import time; b = bytearray(64 << 20); time.sleep(.3); raise SystemExit(3)"])
        self.assertIsNone(bench.reap(p))
        ru = bench.reap(p, block=True)
        self.assertEqual(p.returncode, 3)
        self.assertEqual(p.wait(), 3)
        self.assertGreater(ru.ru_maxrss * (1 if sys.platform == "darwin" else 1024), 60 << 20)

    def test_lean_window_follows_lean_mjs(self):
        w = {lvl: isolation._lean_window({"plugin": Path(__file__).resolve().parents[2]}, lvl) for lvl in (True, "on", "balanced", "max", "ultra")}
        self.assertTrue(all(isinstance(v, int) and v > 0 for v in w.values()), w)
        self.assertEqual(w[True], w["on"])
        with tempfile.TemporaryDirectory() as d:   # builds from before LEAN_WINDOW write no autoCompactWindow
            Path(d, "lib").mkdir()
            Path(d, "lib", "lean.mjs").write_text("export const LEAN_DENY = ['Monitor'];\n")
            self.assertIsNone(isolation._lean_window({"plugin": d}, "balanced"))


if __name__ == "__main__":
    unittest.main()
