"""Tests for the version guard in report.py: python3 -m unittest discover -s bench/runner -p 'test_*.py'"""
import json
import tempfile
import unittest
from pathlib import Path

import report

SHA_A, SHA_B = "a" * 64, "b" * 64


def run(task, agent, tf="0.8.0", sha=SHA_A, cc="2.1.293", tokens=1000):
    tfr = agent == "token-forge"
    return {"run_id": f"{task}-{agent}-{tf}", "task": task, "category": "c", "agent": agent, "status": "completed",
            "task_completed": True, "claude_code_version": cc, "token_forge_version": tf if tfr else None,
            "token_forge_plugin_sha256": sha if tfr else None, "total_tokens": tokens, "quality_score": 100,
            "repository_commit": "x", "prompt_hash": "p", "tests_passed": True}


class Guard(unittest.TestCase):
    def test_one_version_passes_and_is_named(self):
        v = report.check_versions([run("t", "native"), run("t", "token-forge")])
        self.assertEqual(v["token_forge"], [{"version": "0.8.0", "plugin_sha256": SHA_A, "runs": 1}])
        self.assertEqual(report.provenance(v), "TokenForge 0.8.0 (build aaaaaaaaaaaa), 1 runs · Claude Code 2.1.293, 2 runs")

    def test_different_versions_refused_with_list(self):
        rs = [run("t", "token-forge", "0.7.0", SHA_B), run("u", "token-forge")]
        with self.assertRaises(SystemExit) as e:
            report.check_versions(rs, what="reports/x")
        msg = str(e.exception.code)
        self.assertIn("0.7.0 (build bbbbbbbbbbbb): 1 runs", msg)
        self.assertIn("0.8.0 (build aaaaaaaaaaaa): 1 runs", msg)
        self.assertIn("--mixed-versions", msg)

    def test_same_version_other_build_refused(self):
        with self.assertRaises(SystemExit):
            report.check_versions([run("t", "token-forge"), run("u", "token-forge", sha=SHA_B)])

    def test_claude_code_versions_refused(self):
        with self.assertRaises(SystemExit):
            report.check_versions([run("t", "native", cc="2.1.293"), run("t", "native", cc="2.1.295")])

    def test_flag_allows_mix(self):
        v = report.check_versions([run("t", "token-forge", "0.7.0", SHA_B), run("u", "token-forge")], mixed=True)
        self.assertEqual(len(v["token_forge"]), 2)

    def test_published_report_is_mixed(self):
        # bench/reports/benchmark-report.json: 0.7.0 runs (two builds) and 0.8.0 runs; a rebuild needs --mixed-versions
        p = Path(__file__).resolve().parents[1] / "reports" / "benchmark-report.json"
        if not p.exists():
            self.skipTest("no published report")
        rs = json.loads(p.read_text())["runs"]
        with self.assertRaises(SystemExit):
            report.check_versions(rs)
        self.assertGreater(len(report.check_versions(rs, mixed=True)["token_forge"]), 1)


class Build(unittest.TestCase):
    def make(self, d, runs):
        root = Path(d)
        (root / "environments" / "token-forge").mkdir(parents=True)
        (root / "environments" / "token-forge" / "manifest.json").write_text(json.dumps(
            {"token_forge_version": "0.8.0", "plugin_sha256": SHA_A, "claude_code_version": "2.1.293"}))
        (root / "benchmark.config.json").write_text(json.dumps({"token_forge": {"equivalent_builds": {SHA_B: "older"}}}))
        s = root / "runs" / "s1"
        for r in runs:
            m = s / r["task"] / r["run_id"] / "manifest.json"
            m.parent.mkdir(parents=True)
            m.write_text(json.dumps(r))
        return root, s

    def test_report_refuses_then_labels(self):
        rs = [run("t", "native"), run("t", "token-forge", "0.7.0", SHA_B), run("u", "native"), run("u", "token-forge")]
        with tempfile.TemporaryDirectory() as d:
            root, s = self.make(d, rs)
            with self.assertRaises(SystemExit):
                report.build([s], root)
            self.assertFalse((root / "reports" / "benchmark-report.md").exists())
            report.build([s], root, mixed_versions=True)
            md = (root / "reports" / "benchmark-report.md").read_text()
        self.assertIn("| t | Token Forge 0.7.0 (build bbbbbbbbbbbb) |", md)
        self.assertIn("| u | Token Forge 0.8.0 (build aaaaaaaaaaaa) |", md)
        self.assertIn("**Versions of the runs in this report:** TokenForge 0.7.0 (build bbbbbbbbbbbb), 1 runs; "
                      "0.8.0 (build aaaaaaaaaaaa), 1 runs · Claude Code 2.1.293, 4 runs.", md)

    def test_single_version_report_names_it_under_every_table(self):
        rs = [run("t", "native"), run("t", "token-forge")]
        with tempfile.TemporaryDirectory() as d:
            root, s = self.make(d, rs)
            md = report.render_md(report.build([s], root))
        cap = "_Runs used: TokenForge 0.8.0 (build aaaaaaaaaaaa), 1 runs · Claude Code 2.1.293, 2 runs._"
        self.assertEqual(md.count(cap), 6)
        self.assertIn("| t | Token Forge |", md)   # rows are labelled only when versions are mixed


if __name__ == "__main__":
    unittest.main()
