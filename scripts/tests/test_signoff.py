"""`just signoff` against a bare origin and fake tools: what it signs, and when it refuses."""

from __future__ import annotations

import unittest

from harness import CHECKS, Sandbox


class SignoffTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sandbox = Sandbox()
        self.addCleanup(self.sandbox.close)

    def signoff(self) -> tuple[int, str]:
        result = self.sandbox.run("signoff.py")
        return result.returncode, result.stderr

    def test_signs_off_the_pushed_head_after_every_check(self) -> None:
        head = self.sandbox.head()
        code, _ = self.signoff()
        self.assertEqual(code, 0)
        self.assertEqual(self.sandbox.checks_run(), CHECKS)
        self.assertEqual(self.sandbox.load()["statuses"], {head: "success"})

    def test_a_failing_check_signs_nothing(self) -> None:
        self.sandbox.update(failing=["just check"])
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        self.assertIn("`just check` failed; nothing was signed off", stderr)
        self.assertEqual(self.sandbox.checks_run(), CHECKS[:2])
        self.assertEqual(self.sandbox.load()["statuses"], {})

    def test_refuses_untracked_files_and_leaves_them(self) -> None:
        notes = self.sandbox.work / ".napkin" / "notes.md"
        notes.parent.mkdir()
        notes.write_text("draft\n", encoding="utf-8")
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        self.assertIn(
            "uncommitted or untracked files: .napkin/notes.md; "
            "commit or remove them, then push",
            stderr,
        )
        self.assertEqual(self.sandbox.checks_run(), [])
        self.assertEqual(notes.read_text(encoding="utf-8"), "draft\n")

    def test_refuses_a_head_github_does_not_have(self) -> None:
        self.sandbox.commit("local only")
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        self.assertIn("HEAD is not pushed to origin/feature; run: git push", stderr)
        self.assertEqual(self.sandbox.checks_run(), [])

    def test_refuses_a_detached_head(self) -> None:
        self.sandbox.git("switch", "--quiet", "--detach")
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        self.assertIn("HEAD is detached; check out the PR branch first", stderr)
        self.assertEqual(self.sandbox.checks_run(), [])

    def test_refuses_a_signed_out_gh(self) -> None:
        self.sandbox.update(signed_in=False)
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        self.assertIn(
            "`gh auth status` fails for github.com: sign in with gh auth login", stderr
        )
        self.assertEqual(self.sandbox.checks_run(), [])

    def test_refuses_when_github_has_newer_commits(self) -> None:
        self.sandbox.commit("pushed from elsewhere")
        self.sandbox.git("push", "--quiet")
        self.sandbox.git("reset", "--quiet", "--hard", "HEAD~1")
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        self.assertIn("GitHub has newer commits on origin/feature", stderr)

    def test_refuses_before_the_checks_when_main_does_not_require_signoff(
        self,
    ) -> None:
        self.sandbox.update(rules=[])
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        self.assertIn(
            "main on pascalandy/pi-journey does not require the signoff status; "
            "run: just signoff-setup",
            stderr,
        )
        self.assertEqual(self.sandbox.checks_run(), [])

    def test_a_signoff_check_bound_to_an_app_does_not_count(self) -> None:
        required = [{"context": "signoff", "integration_id": 15368}]
        self.sandbox.update(
            rules=[
                {
                    "type": "required_status_checks",
                    "parameters": {"required_status_checks": required},
                }
            ]
        )
        result = self.sandbox.run("signoff.py", "check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("run: just signoff-setup", result.stderr)

    def test_an_unreadable_rule_is_an_access_failure_not_missing_setup(self) -> None:
        self.sandbox.update(rules=None)
        result = self.sandbox.run("signoff.py", "check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Bad credentials (HTTP 401)", result.stderr)
        self.assertNotIn("signoff-setup", result.stderr)

    def test_check_reads_the_repository_from_origin(self) -> None:
        self.sandbox.git(
            "remote", "set-url", "origin", "https://github.com/pascalandy/pi-journey"
        )
        result = self.sandbox.run("signoff.py", "check")
        self.assertEqual(
            (result.returncode, result.stdout),
            (0, "main on pascalandy/pi-journey requires the signoff status\n"),
        )
        self.sandbox.git("remote", "set-url", "origin", "/srv/git/pi-journey.git")
        result = self.sandbox.run("signoff.py", "check")
        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "origin is not a GitHub repository: /srv/git/pi-journey.git", result.stderr
        )

    def test_setup_installs_the_rule_then_verifies_it(self) -> None:
        self.sandbox.update(rules=[])
        result = self.sandbox.run("signoff.py", "setup")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.stdout,
            "✓ Required signoff on main\n"
            "main on pascalandy/pi-journey requires the signoff status\n",
        )

    def test_signs_nothing_when_head_moves_during_the_checks(self) -> None:
        head = self.sandbox.head()
        self.sandbox.update(hooks={"just check": "git commit -q --allow-empty -m moved"})
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        self.assertIn(
            f"HEAD moved from {head[:7]} while the checks ran; nothing was signed off",
            stderr,
        )
        self.assertEqual(self.sandbox.load()["statuses"], {})

    def test_signs_nothing_when_github_moves_during_the_checks(self) -> None:
        head = self.sandbox.head()
        push_elsewhere = (
            "git commit -q --allow-empty -m elsewhere && git push -q "
            "&& git reset -q --hard HEAD~1"
        )
        self.sandbox.update(hooks={"just check": push_elsewhere})
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        tip = self.sandbox.git("rev-parse", "origin/feature")
        self.assertIn(
            f"origin/feature moved from {head[:7]} to {tip[:7]} while the checks ran",
            stderr,
        )
        self.assertEqual(self.sandbox.load()["statuses"], {})

    def test_signs_nothing_when_the_checks_change_files(self) -> None:
        self.sandbox.update(hooks={"just check": "echo built > stray.txt"})
        code, stderr = self.signoff()
        self.assertEqual(code, 1)
        self.assertIn("uncommitted or untracked files: stray.txt", stderr)
        self.assertEqual(self.sandbox.load()["statuses"], {})


if __name__ == "__main__":
    unittest.main()
