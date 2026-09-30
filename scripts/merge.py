#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Merge the current branch's PR into main: sign off its pushed head, then merge that commit.

Agents run it only after Pascal authorizes the merge. It refuses before the
checks when the checkout or the PR is not ready, and it never bypasses a rule.
A rerun after an interruption finds a merged PR and reports it.

Usage:
    just merge [--subject TEXT]

Exit codes: 0 merged or already merged, 1 refused or failed, 2 bad usage.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass

from signoff import (
    Refused,
    current_branch,
    gh,
    git,
    github_repo,
    pushed_head,
    require_clean_tree,
    require_signoff_rule,
    require_tools,
    sign,
    succeeds,
)

FIELDS = (
    "number,url,title,state,isDraft,baseRefName,headRefOid,isCrossRepository,"
    "mergeStateStatus,mergeCommit,statusCheckRollup,autoMergeRequest"
)
# The merge states in which GitHub merges without a bypass
MERGEABLE = {"CLEAN", "HAS_HOOKS"}
# What each other state needs. GitHub recomputes the state after a new status,
# so only a conflict or a draft is final before WAIT_SECONDS
BLOCKERS = {
    "BEHIND": "is behind main; run: git merge origin/main, push, then rerun just merge",
    "BLOCKED": "is blocked by a required review or check",
    "DIRTY": "conflicts with main; merge origin/main, resolve, push, then rerun just merge",
    "DRAFT": "is a draft; mark it ready with: gh pr ready",
    "UNKNOWN": "has a merge state GitHub has not computed; rerun just merge in a minute",
    "UNSTABLE": "has a failing check",
}
FINAL = {"DIRTY", "DRAFT"}
WAIT_SECONDS = 60
POLL_SECONDS = 3
# A leading "✨ feat: scope: " or "feat(scope): ", and a trailing "(stack 2/4)"
TITLE_TYPE = re.compile(
    r"^(?:[^\x00-\x7f]\S*\s+)?[a-z]+(?:\([^)]*\))?!?:\s+(?:[\w./-]+:\s+)?"
)
TITLE_STACK = re.compile(r"\s*\(stack \d+/\d+\)$")


@dataclass(frozen=True)
class PullRequest:
    number: int
    url: str
    title: str
    state: str
    draft: bool
    base: str
    head: str
    fork: bool
    merge_state: str
    merge_commit: str | None
    signed_off: bool
    auto_merge: bool

    @classmethod
    def parse(cls, raw: dict) -> PullRequest:
        return cls(
            number=raw["number"],
            url=raw["url"],
            title=raw["title"],
            state=raw["state"],
            draft=raw["isDraft"],
            base=raw["baseRefName"],
            head=raw["headRefOid"],
            fork=raw["isCrossRepository"],
            merge_state=raw["mergeStateStatus"],
            merge_commit=(raw.get("mergeCommit") or {}).get("oid"),
            signed_off=any(
                check.get("context") == "signoff" and check.get("state") == "SUCCESS"
                for check in raw.get("statusCheckRollup") or []
            ),
            auto_merge=raw.get("autoMergeRequest") is not None,
        )


def merge_subject(title: str, number: int) -> str:
    """The subject of a merge commit on main, as in `🔀 merge: add just merge (#80)`."""
    summary = TITLE_STACK.sub("", TITLE_TYPE.sub("", title, count=1)) or title
    return f"🔀 merge: {summary} (#{number})"


def view(repo: str, number: int) -> PullRequest:
    return PullRequest.parse(
        json.loads(gh(repo, "pr", "view", str(number), "--json", FIELDS))
    )


def branch_pr(repo: str, branch: str) -> PullRequest:
    """The branch's open PR, or else its latest merged one."""
    listed = gh(
        repo, "pr", "list", "--head", branch, "--state", "all", "--json", FIELDS
    )
    prs = [PullRequest.parse(raw) for raw in json.loads(listed)]
    open_prs = [pr for pr in prs if pr.state == "OPEN"]
    if len(open_prs) > 1:
        numbers = ", ".join(f"#{pr.number}" for pr in open_prs)
        raise Refused(
            f"{branch} has several open PRs ({numbers}); close all but one, "
            "then rerun just merge"
        )
    merged = [pr for pr in prs if pr.state == "MERGED"]
    if not open_prs and not merged:
        raise Refused(
            f"{branch} has no open PR; open one with: gh pr create --base main"
        )
    return (open_prs or merged)[0]


def require_contains_main(sha: str) -> None:
    """Require sha to contain main's tip, so the merge brings in no untested code."""
    git("fetch", "--quiet", "origin", "main")
    main = git("rev-parse", "FETCH_HEAD")
    if not succeeds("git", "merge-base", "--is-ancestor", main, sha):
        raise Refused(
            f"the branch at {sha[:7]} does not contain main's tip {main[:7]}; "
            "run: git merge origin/main, push, then rerun just merge"
        )


def wait_until_mergeable(repo: str, number: int, sha: str) -> PullRequest:
    """Wait for GitHub to count the new signoff; return the PR once it can merge sha."""
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        pr = view(repo, number)
        if pr.state != "OPEN":
            raise Refused(
                f"PR #{number} was {pr.state.lower()} during the checks; "
                "rerun just merge to see where it stands"
            )
        if pr.base != "main":
            raise Refused(
                f"PR #{number} now targets {pr.base}, not main; retarget it to main, "
                "then rerun just merge"
            )
        if pr.head != sha:
            raise Refused(
                f"PR #{number} moved from {sha[:7]} to {pr.head[:7]} after the "
                "signoff; rerun just merge to check the new head"
            )
        if pr.signed_off and pr.merge_state in MERGEABLE:
            return pr
        if pr.merge_state in FINAL or time.monotonic() > deadline:
            blocker = BLOCKERS.get(pr.merge_state, "shows no green signoff yet")
            raise Refused(f"PR #{number} {blocker}: {pr.url}")
        time.sleep(POLL_SECONDS)


def land(repo: str, pr: PullRequest, sha: str, subject: str) -> None:
    """Merge sha, then read the PR back: a failed call can still have merged it."""
    failure = "gh pr merge did not merge it"
    try:
        gh(
            repo,
            "pr",
            "merge",
            str(pr.number),
            "--merge",
            "--match-head-commit",
            sha,
            "--subject",
            subject,
        )
    except Refused as refused:
        failure = str(refused)
    try:
        after = view(repo, pr.number)
    except Refused as refused:
        raise Refused(
            f"{failure}; reading PR #{pr.number} back also failed ({refused}), "
            f"so check it with: gh pr view {pr.number}"
        ) from None
    if after.state != "MERGED":
        raise Refused(
            f"{failure}; PR #{pr.number} is still {after.state.lower()}, so it was "
            "not merged; rerun just merge once that is fixed"
        )
    # --match-head-commit pins the head, not the base
    if after.base != "main":
        raise Refused(f"PR #{pr.number} was merged into {after.base}, not main")
    if after.head != sha:
        raise Refused(
            f"PR #{pr.number} was merged at {after.head[:7]}, not at the tested "
            f"{sha[:7]}; check main"
        )
    print(f"merged PR #{pr.number} at {sha[:7]} as {after.merge_commit[:7]}: {pr.url}")


def merge(subject: str | None) -> None:
    repo = github_repo()
    branch = current_branch()
    # A rerun after a merge needs only gh to report it
    pr = branch_pr(repo, branch)
    head = git("rev-parse", "HEAD")
    if pr.state == "MERGED":
        if pr.base != "main":
            raise Refused(f"PR #{pr.number} was merged into {pr.base}, not main")
        if pr.head != head:
            raise Refused(
                f"PR #{pr.number} was merged at {pr.head[:7]}, but HEAD is "
                f"{head[:7]}; open a new PR for the new commits"
            )
        print(f"PR #{pr.number} is already merged as {pr.merge_commit[:7]}: {pr.url}")
        return
    require_tools()
    if any(rule.get("type") == "merge_queue" for rule in require_signoff_rule(repo)):
        raise Refused("main uses a merge queue, which just merge does not support")
    if pr.fork:
        raise Refused(f"PR #{pr.number} comes from a fork; merge it in GitHub")
    if pr.base != "main":
        raise Refused(
            f"PR #{pr.number} targets {pr.base}, not main; merge the PR below it "
            f"first, then run: gh pr edit {pr.number} --base main"
        )
    if pr.draft:
        raise Refused(
            f"PR #{pr.number} is a draft; mark it ready with: gh pr ready {pr.number}"
        )
    # GitHub would merge it the moment the signoff lands, before the last check
    if pr.auto_merge:
        raise Refused(
            f"PR #{pr.number} has auto-merge on; run just signoff and let it merge, "
            f"or turn it off with: gh pr merge {pr.number} --disable-auto"
        )
    require_clean_tree()
    sha = pushed_head()
    if sha != pr.head:
        raise Refused(
            f"PR #{pr.number} is at {pr.head[:7]}, but {branch} on GitHub is at "
            f"{sha[:7]}; rerun just merge once GitHub catches up"
        )
    require_contains_main(sha)
    # Flush: piped output would otherwise show this line after the checks' output
    print(f"PR #{pr.number}: checking {sha[:7]} before the merge", flush=True)
    sign(repo, sha)
    pr = wait_until_mergeable(repo, pr.number, sha)
    # main can move while the checks run
    require_contains_main(sha)
    land(repo, pr, sha, subject or merge_subject(pr.title, pr.number))


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="just merge",
        description=__doc__.split("\n\n")[0],
    )
    parser.add_argument(
        "--subject",
        help="the merge commit subject; default: 🔀 merge: <PR title> (#N)",
    )
    args = parser.parse_args()
    try:
        merge(args.subject)
    except Refused as refused:
        print(f"error: {refused}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
