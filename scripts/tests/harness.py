"""A throwaway checkout of a pushed branch, with a bare origin and fake tools on PATH."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from fake import REPO, SIGNOFF_RULES

SCRIPTS = Path(__file__).resolve().parent.parent
# The tests import the scripts they cover
sys.path.insert(0, str(SCRIPTS))
FAKE = Path(__file__).with_name("fake.py")
REMOTE = f"git@github.com:{REPO}.git"
PROGRAMS = ("gh", "pnpm", "just", "gitleaks")
# What a signoff runs, in order
CHECKS = ["pnpm install --frozen-lockfile", "just check", "just gitleaks"]


class Sandbox:
    """`work` has `feature` checked out and pushed; `origin` also has `main`."""

    def __init__(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.origin = root / "origin.git"
        self.work = root / "work"
        self.state_path = root / "state.json"
        fakes = root / "bin"
        fakes.mkdir()
        for name in PROGRAMS:
            wrapper = fakes / name
            wrapper.write_text(
                f'#!/bin/sh\nexec "{sys.executable}" "{FAKE}" {name} "$@"\n',
                encoding="utf-8",
            )
            wrapper.chmod(0o755)
        gitconfig = root / "gitconfig"
        # A leftover GIT_DIR, as in a git hook, would point every git call at the real repo
        self.env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("GIT_") and key != "GH_REPO"
        }
        self.env.update(
            PATH=f"{fakes}{os.pathsep}{os.environ['PATH']}",
            FAKE_STATE=str(self.state_path),
            GIT_CONFIG_GLOBAL=str(gitconfig),
            GIT_CONFIG_NOSYSTEM="1",
        )
        for key, value in (
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("init.defaultBranch", "main"),
            ("commit.gpgsign", "false"),
            # origin keeps its GitHub URL, which names the repository, and git
            # reaches the bare repo in its place
            (f"url.{self.origin}.insteadOf", REMOTE),
        ):
            self.git("config", "--file", str(gitconfig), key, value, cwd=root)
        self.git("init", "--quiet", "--bare", str(self.origin), cwd=root)
        self.git("init", "--quiet", str(self.work), cwd=root)
        self.git("remote", "add", "origin", REMOTE)
        self.commit("main")
        self.git("push", "--quiet", "--set-upstream", "origin", "main")
        self.git("switch", "--quiet", "--create", "feature")
        self.commit("feature")
        self.git("push", "--quiet", "--set-upstream", "origin", "feature")
        self.save(
            {
                "origin": str(self.origin),
                "signed_in": True,
                "rules": SIGNOFF_RULES,
                "statuses": {},
                "prs": [],
                "merge_error": None,
                "hooks": {},
                "failing": [],
                "calls": [],
            }
        )

    def close(self) -> None:
        self._tmp.cleanup()

    def git(self, *args: str, cwd: Path | None = None) -> str:
        return subprocess.run(
            ("git", *args),
            cwd=cwd or self.work,
            env=self.env,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    def commit(self, message: str) -> str:
        """Commit a new file named after message, so every commit changes the tree."""
        name = message.replace(" ", "-")
        (self.work / f"{name}.txt").write_text(f"{message}\n", encoding="utf-8")
        self.git("add", f"{name}.txt")
        self.git("commit", "--quiet", "--message", message)
        return self.head()

    def head(self) -> str:
        return self.git("rev-parse", "HEAD")

    def load(self) -> dict:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def save(self, state: dict) -> None:
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

    def update(self, **changes: object) -> None:
        self.save({**self.load(), **changes})

    def run(self, script: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (sys.executable, str(SCRIPTS / script), *args),
            cwd=self.work,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
        )

    def checks_run(self) -> list[str]:
        """The non-gh programs the script ran, in order."""
        return [
            " ".join(call["argv"])
            for call in self.load()["calls"]
            if call["argv"][0] != "gh"
        ]
