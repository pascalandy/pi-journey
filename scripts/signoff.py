#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Install, run `just check` and `just gitleaks`, then post a green `signoff` on the pushed HEAD.

The status is the merge gate for pull requests into main. It belongs to one
commit, so every push needs a new signoff.

Usage:
    just signoff          check the pushed HEAD, then sign it off
    just signoff-check    verify that main requires the signoff status
    just signoff-setup    require the signoff status on main, then verify it

Exit codes: 0 success, 1 refused or a check failed, 2 bad usage.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

# The install runs first so a dependency bump is checked against its own lockfile
CHECKS = (
    ("pnpm", "install", "--frozen-lockfile"),
    ("just", "check"),
    ("just", "gitleaks"),
)
FORK_HINT = (
    "For a PR from a fork, read its whole diff first, since the checks run its code, "
    "then run: pnpm install --frozen-lockfile && just check && just gitleaks && gh signoff"
)
# owner/name in an SSH or HTTPS GitHub URL
GITHUB_URL = re.compile(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$")


class Refused(Exception):
    """A precondition failed; the message says how to fix it."""


def git(*args: str) -> str:
    result = subprocess.run(("git", *args), capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise Refused(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    # Not strip: a porcelain status line can start with a space
    return result.stdout.rstrip()


def succeeds(*command: str) -> bool:
    return subprocess.run(command, capture_output=True, check=False).returncode == 0


def github_repo() -> str:
    """The owner/name of origin, the repository whose main the rules protect."""
    url = subprocess.run(
        ("git", "config", "--get", "remote.origin.url"),
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    if match := GITHUB_URL.search(url):
        return match.group(1)
    raise Refused(f"origin is not a GitHub repository: {url or 'no origin remote'}")


def gh(repo: str, *args: str) -> str:
    """Run gh against repo and return its output.

    GH_REPO pins the repository, so a second remote such as upstream cannot
    make gh guess."""
    try:
        result = subprocess.run(
            ("gh", *args),
            capture_output=True,
            text=True,
            check=False,
            env={**os.environ, "GH_REPO": repo},
        )
    except FileNotFoundError:
        raise Refused("gh not found; install the GitHub CLI: brew install gh") from None
    if result.returncode != 0:
        raise Refused(f"`gh {' '.join(args)}` failed: {result.stderr.strip()}")
    return result.stdout


def require_signoff_rule(repo: str) -> list[dict]:
    """Return the rules GitHub enforces on main, once they require the signoff status.

    `gh signoff check` reads a failed API call as "not required", and it exits 0
    when main requires only other signoff contexts, so read the rules directly."""
    rules = json.loads(gh(repo, "api", f"repos/{repo}/rules/branches/main"))
    required = {
        status.get("context")
        for rule in rules
        if rule.get("type") == "required_status_checks"
        for status in rule.get("parameters", {}).get("required_status_checks", [])
        # A check bound to an app accepts only that app's status, never gh signoff's
        if status.get("integration_id") is None
    }
    if "signoff" not in required:
        raise Refused(
            f"main on {repo} does not require the signoff status; "
            "run: just signoff-setup"
        )
    return rules


def require_tools() -> None:
    for tool, fix in (
        ("pnpm", "install pnpm: corepack enable pnpm"),
        ("gh", "install the GitHub CLI: brew install gh"),
        ("gitleaks", "install gitleaks: brew install gitleaks"),
        ("just", "install just: brew install just"),
    ):
        if shutil.which(tool) is None:
            raise Refused(f"{tool} not found; {fix}")
    extensions = subprocess.run(
        ("gh", "extension", "list"), capture_output=True, text=True, check=False
    ).stdout
    if "gh-signoff" not in extensions:
        raise Refused(
            "the gh signoff extension is missing; "
            "run: gh extension install basecamp/gh-signoff"
        )
    if not succeeds("gh", "auth", "status", "--hostname", "github.com"):
        # It also fails offline, so name both causes
        raise Refused(
            "`gh auth status` fails for github.com: sign in with gh auth login, "
            "or check your network"
        )
    if not succeeds("git", "config", "user.name"):
        raise Refused(
            'git user.name is not set; run: git config --global user.name "..."'
        )


def require_clean_tree() -> None:
    """Refuse changed or untracked files, and name them; the checks would test them."""
    paths = [
        line[3:]
        for line in git("status", "--porcelain", "--untracked-files=all").splitlines()
    ]
    if paths:
        shown = ", ".join(paths[:10]) + (
            f", and {len(paths) - 10} more" if len(paths) > 10 else ""
        )
        raise Refused(
            f"the working tree has uncommitted or untracked files: {shown}; "
            "commit or remove them, then push"
        )


def current_branch() -> str:
    branch = subprocess.run(
        ("git", "symbolic-ref", "--quiet", "--short", "HEAD"),
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    if not branch:
        raise Refused("HEAD is detached; check out the PR branch first")
    return branch


def upstream_tip() -> tuple[str, str]:
    """Fetch the current branch's upstream; return its name and the commit GitHub has."""
    branch = current_branch()
    # The upstream names the remote branch exactly; git push -u and gh pr checkout
    # both set it
    remote, _, remote_ref = git(
        "for-each-ref",
        "--format=%(upstream:remotename)%09%(upstream:remoteref)",
        f"refs/heads/{branch}",
    ).partition("\t")
    if not remote or not remote_ref:
        raise Refused(
            f"{branch} has no upstream; run: git push -u origin HEAD. {FORK_HINT}"
        )
    git("fetch", "--quiet", remote, remote_ref)
    upstream = f"{remote}/{remote_ref.removeprefix('refs/heads/')}"
    return upstream, git("rev-parse", "FETCH_HEAD")


def pushed_head() -> str:
    """Return HEAD once it is exactly the commit GitHub has for this branch."""
    upstream, tip = upstream_tip()
    head = git("rev-parse", "HEAD")
    if head == tip:
        return head
    if succeeds("git", "merge-base", "--is-ancestor", head, tip):
        raise Refused(f"GitHub has newer commits on {upstream}; run: git pull")
    raise Refused(f"HEAD is not pushed to {upstream}; run: git push")


def sign(repo: str, sha: str) -> None:
    """Run the checks on the checkout of sha, then sign off sha if nothing moved."""
    for command in CHECKS:
        if subprocess.run(command, check=False).returncode != 0:
            raise Refused(f"`{' '.join(command)}` failed; nothing was signed off")
    # The checks take minutes; the status must name the commit they tested
    if git("rev-parse", "HEAD") != sha:
        raise Refused(
            f"HEAD moved from {sha[:7]} while the checks ran; nothing was signed off"
        )
    require_clean_tree()
    upstream, tip = upstream_tip()
    if tip != sha:
        raise Refused(
            f"{upstream} moved from {sha[:7]} to {tip[:7]} while the checks ran; "
            "nothing was signed off"
        )
    print(gh(repo, "signoff", "--commit", sha), end="")


def signoff() -> None:
    require_tools()
    repo = github_repo()
    require_signoff_rule(repo)
    require_clean_tree()
    sign(repo, pushed_head())


def check_rule() -> None:
    repo = github_repo()
    require_signoff_rule(repo)
    print(f"main on {repo} requires the signoff status")


def setup() -> None:
    print(gh(github_repo(), "signoff", "install"), end="")
    check_rule()


COMMANDS = {"sign": signoff, "check": check_rule, "setup": setup}


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="scripts/signoff.py",
        description=__doc__.split("\n\n")[0],
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="sign",
        choices=COMMANDS,
        help="sign (the default) checks and signs off HEAD; "
        "check reads main's rules; setup installs the signoff rule on main",
    )
    args = parser.parse_args()
    try:
        COMMANDS[args.command]()
    except Refused as refused:
        print(f"error: {refused}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
