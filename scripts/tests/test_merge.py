"""`just merge` against a bare origin and a fake GitHub: what lands on main, and when nothing does."""

from __future__ import annotations

import unittest

from harness import CHECKS, Sandbox
from merge import merge_subject

URL = "https://github.com/pascalandy/pi-journey/pull/7"


class MergeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sandbox = Sandbox()
        self.addCleanup(self.sandbox.close)
        self.open_pr()

    def open_pr(self, **changes: object) -> None:
        pr = {
            "number": 7,
            "title": "✨ feat: merge: add the thing (stack 2/4)",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "main",
            "headRefName": "feature",
            "headRefOid": "",
            "isCrossRepository": False,
            "conflicts": False,
            "mergeCommit": None,
            "autoMergeRequest": None,
        }
        self.sandbox.update(prs=[{**pr, **changes}], calls=[])

    def merge(self) -> tuple[int, str, str]:
        result = self.sandbox.run("merge.py")
        return result.returncode, result.stdout, result.stderr

    def main(self) -> str:
        return self.sandbox.git(
            "--git-dir", str(self.sandbox.origin), "rev-parse", "main"
        )

    def test_signs_off_the_tested_head_then_merges_exactly_it(self) -> None:
        head, main = self.sandbox.head(), self.main()
        code, stdout, _ = self.merge()
        self.assertEqual(code, 0)
        self.assertEqual(self.sandbox.checks_run(), CHECKS)
        self.assertEqual(self.sandbox.load()["statuses"], {head: "success"})
        merged = self.main()
        self.assertEqual(
            self.sandbox.git(
                "--git-dir",
                str(self.sandbox.origin),
                "log",
                "-1",
                "--format=%P%n%s",
                merged,
            ),
            f"{main} {head}\n🔀 merge: add the thing (#7)",
        )
        self.assertEqual(
            self.sandbox.git("rev-parse", f"{head}^{{tree}}"),
            self.sandbox.git(
                "--git-dir", str(self.sandbox.origin), "rev-parse", f"{merged}^{{tree}}"
            ),
        )
        self.assertTrue(
            stdout.endswith(f"merged PR #7 at {head[:7]} as {merged[:7]}: {URL}\n")
        )

    def test_a_rerun_reports_the_merge_without_checking_again(self) -> None:
        self.merge()
        merged = self.main()
        self.sandbox.update(calls=[])
        code, stdout, _ = self.merge()
        self.assertEqual(
            (code, stdout), (0, f"PR #7 is already merged as {merged[:7]}: {URL}\n")
        )
        self.assertEqual(self.sandbox.checks_run(), [])
        self.assertEqual(self.main(), merged)

    def test_a_rerun_reports_the_merge_before_checking_the_setup(self) -> None:
        self.merge()
        self.sandbox.update(rules=[])
        code, stdout, _ = self.merge()
        self.assertEqual(code, 0)
        self.assertIn("PR #7 is already merged", stdout)

    def test_refuses_before_the_checks_when_the_pr_cannot_merge_as_is(self) -> None:
        cases = {
            "comes from a fork": {"isCrossRepository": True},
            "targets layer-1, not main": {"baseRefName": "layer-1"},
            "is a draft": {"isDraft": True},
            "has auto-merge on": {"autoMergeRequest": {"mergeMethod": "MERGE"}},
        }
        for refusal, changes in cases.items():
            with self.subTest(refusal):
                self.open_pr(**changes)
                code, _, stderr = self.merge()
                self.assertEqual(code, 1)
                self.assertIn(f"PR #7 {refusal}", stderr)
                self.assertEqual(self.sandbox.checks_run(), [])

    def test_refuses_a_branch_without_a_pr(self) -> None:
        self.sandbox.update(prs=[])
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn(
            "feature has no open PR; open one with: gh pr create --base main", stderr
        )

    def test_refuses_a_merge_queue(self) -> None:
        self.sandbox.update(
            rules=[*self.sandbox.load()["rules"], {"type": "merge_queue"}]
        )
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn("main uses a merge queue", stderr)
        self.assertEqual(self.sandbox.checks_run(), [])

    def test_refuses_a_branch_that_lacks_main_tip(self) -> None:
        self.sandbox.git("switch", "--quiet", "main")
        tip = self.sandbox.commit("main moves on")
        self.sandbox.git("push", "--quiet")
        self.sandbox.git("switch", "--quiet", "feature")
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn(
            f"does not contain main's tip {tip[:7]}; run: git merge origin/main",
            stderr,
        )
        self.assertEqual(self.sandbox.checks_run(), [])

    def test_merges_nothing_when_main_moves_during_the_checks(self) -> None:
        move_main = (
            "git switch -q main && git commit -q --allow-empty -m moved "
            "&& git push -q && git switch -q feature"
        )
        self.sandbox.update(hooks={"just check": move_main})
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn("does not contain main's tip", stderr)
        self.assertEqual(self.sandbox.load()["prs"][0]["state"], "OPEN")

    def test_checks_the_tested_commit_not_head_against_main(self) -> None:
        catch_up_locally = (
            "git switch -q main && git commit -q --allow-empty -m moved && git push -q "
            "&& git switch -q feature && git merge -q --no-edit main"
        )
        self.sandbox.update(hooks={"gh signoff": catch_up_locally})
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn("does not contain main's tip", stderr)
        self.assertEqual(self.sandbox.load()["prs"][0]["state"], "OPEN")

    def test_merges_nothing_when_the_pr_moves_after_the_signoff(self) -> None:
        head = self.sandbox.head()
        push_elsewhere = (
            "git commit -q --allow-empty -m elsewhere && git push -q "
            "&& git reset -q --hard HEAD~1"
        )
        self.sandbox.update(hooks={"gh signoff": push_elsewhere})
        main = self.main()
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        tip = self.sandbox.git("rev-parse", "origin/feature")
        self.assertIn(
            f"PR #7 moved from {head[:7]} to {tip[:7]} after the signoff", stderr
        )
        self.assertEqual(self.main(), main)

    def test_merges_nothing_when_the_pr_is_retargeted_during_the_checks(self) -> None:
        self.sandbox.update(hooks={"just check": {"baseRefName": "layer-1"}})
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn("PR #7 now targets layer-1, not main", stderr)
        self.assertEqual(self.sandbox.load()["prs"][0]["state"], "OPEN")

    def test_stops_when_the_pr_is_merged_elsewhere_during_the_checks(self) -> None:
        self.sandbox.update(hooks={"just check": {"state": "MERGED"}})
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn("PR #7 was merged during the checks", stderr)

    def test_a_merge_into_another_branch_is_not_reported_as_merged(self) -> None:
        self.sandbox.git("push", "--quiet", "origin", "main:layer-1")
        self.sandbox.update(hooks={"gh pr merge": {"baseRefName": "layer-1"}})
        code, stdout, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertNotIn("merged PR #7", stdout)
        self.assertIn("PR #7 was merged into layer-1, not main", stderr)

    def test_refuses_a_pr_merged_into_another_branch(self) -> None:
        self.open_pr(
            state="MERGED",
            baseRefName="layer-1",
            headRefOid=self.sandbox.head(),
            mergeCommit={"oid": "0" * 40},
        )
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn("PR #7 was merged into layer-1, not main", stderr)

    def test_stops_at_a_conflict_without_merging(self) -> None:
        self.open_pr(conflicts=True)
        main = self.main()
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn(
            f"PR #7 conflicts with main; merge origin/main, resolve, push, then rerun just merge: {URL}",
            stderr,
        )
        self.assertEqual(self.main(), main)

    def test_a_merge_whose_answer_is_lost_still_counts(self) -> None:
        self.sandbox.update(merge_error="lost")
        code, stdout, _ = self.merge()
        self.assertEqual(code, 0)
        self.assertIn(f"merged PR #7 at {self.sandbox.head()[:7]}", stdout)

    def test_a_refused_merge_leaves_main_and_says_to_rerun(self) -> None:
        self.sandbox.update(merge_error="refused")
        main = self.main()
        code, _, stderr = self.merge()
        self.assertEqual(code, 1)
        self.assertIn("error connecting to api.github.com; PR #7 is still open", stderr)
        self.assertIn("rerun just merge", stderr)
        self.assertEqual(self.main(), main)

    def test_the_subject_keeps_only_the_summary_of_the_title(self) -> None:
        cases = {
            "✨ feat: signoff: gate merges with just signoff (stack 2/4)": "🔀 merge: gate merges with just signoff (#7)",
            "feat(merge): add just merge": "🔀 merge: add just merge (#7)",
            "🚑 fix: 3:00 AM builds": "🔀 merge: 3:00 AM builds (#7)",
            "Agent-native repo: one verdict (#70)": "🔀 merge: Agent-native repo: one verdict (#70) (#7)",
        }
        for title, subject in cases.items():
            with self.subTest(title):
                self.assertEqual(merge_subject(title, 7), subject)


if __name__ == "__main__":
    unittest.main()
